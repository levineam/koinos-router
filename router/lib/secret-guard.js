"use strict";

const path = require("path");

/*
 * Secret guard: the last check before text leaves this Mac.
 *
 * Delegations run on volunteers' computers, and the volunteer serving a job
 * can read the prompt. So anything that looks like a credential blocks the
 * whole delegation (the agent then does the task itself). We never redact
 * silently: a half-redacted config is still a map of where the secrets live,
 * and the agent should know why its delegation was refused.
 *
 * The other side of the trade is false positives. Every block is a premium
 * call the user pays for, so ordinary logs and code must pass: git hashes
 * (hex tops out at 4.0 bits/char of entropy, and none sit in an assignment),
 * UUIDs, minified bundles and base64 images. That is why the generic rules
 * only fire on values *assigned to secret-ish names*, never on bare strings.
 */

// Known token shapes. Bounded quantifiers everywhere: these run over 2 MB
// inputs whose lines can be one long minified run, and an unbounded class
// followed by a failing tail backtracks quadratically.
const TOKEN_RULES = [
  { type: "private_key", re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g, header: true },
  { type: "private_key", re: /PuTTY-User-Key-File-\d{1,2}:/g, header: true },
  // A PEM file base64-encoded once more: kubeconfig client-key-data, a k8s
  // Secret's tls.key. "LS0tLS1CRUdJTi" is "-----BEGIN"; decoding the head
  // tells a private key from the (public) certificates beside it.
  { type: "private_key", re: /\bLS0tLS1CRUdJTi[A-Za-z0-9+/]{0,120}/g, check: m => isBase64PrivateKey(m[0]), preview: () => "LS0tLS1CRUdJTi… (base64 private key)" },
  { type: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { type: "github_token", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { type: "gitlab_token", re: /\bglpat-[A-Za-z0-9_-]{20,255}/g },
  { type: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, check: m => /\d/.test(m[0].slice(4)) || isMixedCase(m[0].slice(4) + "0") },
  { type: "vault_token", re: /\bhv[sbr]\.[A-Za-z0-9_-]{24,500}/g },
  { type: "huggingface_token", re: /\bhf_[A-Za-z0-9]{30,64}(?![A-Za-z0-9_])/g, check: m => /[a-z]/.test(m[0].slice(3)) && /[A-Z]/.test(m[0]) },
  { type: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,300}/g },
  // Real OpenAI keys are mixed-case base62; requiring that keeps slugs like
  // "sk-learn-compatible-estimator-2" out.
  { type: "openai_key", re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?([A-Za-z0-9_-]{20,300})/g, check: m => isMixedCase(m[1]) },
  { type: "slack_token", re: /\bxox[abpr]-[A-Za-z0-9-]{10,250}/g, check: m => /\d/.test(m[0]) },
  { type: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { type: "stripe_key", re: /\b[sr]k_live_[0-9A-Za-z]{16,250}/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,2000}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000}/g },
  // scheme://user:password@host — database URLs are the classic log leak.
  { type: "url_credentials", re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`]{1,64}:([^\s/@'"`]{6,128})@[^\s/'"`]/gi, check: m => !isPlaceholder(m[1]), secretGroup: 1 },
];

// `Authorization: Bearer …` in curl -v output, HTTP dumps and proxy logs.
const AUTH_HEADER_RE = /\b(?:proxy-)?authorization["']?[ \t]{0,8}[:=][ \t]{0,8}["']?(?:bearer|basic|token|digest)[ \t]{1,8}([^\s"'`,;)]{12,2000})/dgi;
// `Cookie:` / `Set-Cookie:` headers; only session-like cookie names count.
const COOKIE_HEADER_RE = /\b(?:set-)?cookie["']?[ \t]{0,8}:[ \t]{0,8}/gi;
const COOKIE_PAIR_RE = /([A-Za-z0-9_.-]{1,64})=([^;\s,"'`]{1,2000})/dg;
const SESSION_COOKIE_RE = /sess|sid|auth|token|jwt|login|remember|identity|credential/i;
// `mysql -u root -pS3cret` (the password glued to -p).
const MYSQL_P_RE = /\bmysql(?:dump|admin|import|sh)?\b[^\n]{0,400}?[ \t]-p([^\s'"`;|&]{4,128})/dg;

// `name = "value"`, `name: 'value'`, `"name": "value"`, `name := "value"`.
const QUOTED_ASSIGN_RE = /(["']?)([A-Za-z_$][\w$.-]{0,63})\1[ \t]{0,8}(?::=|=>|[:=])[ \t]{0,8}(["'`])([^"'`\s]{1,1024})\3/dg;
// `NAME=value` / `name: value` / `--name=value` anywhere in a line: .env and
// shell lines, YAML and compose list items (`- POSTGRES_PASSWORD=…`), values
// followed by a comment or `;`, CLI flags. The value ends at whitespace,
// a comment, a separator or a quote.
const BARE_ASSIGN_RE = /(?:^|[^\w.$-])(?:(?:export|set|setenv)[ \t]+)?(?:--?)?([A-Za-z_][\w.-]{0,63})[ \t]{0,8}(?:=|:(?![/\\]))[ \t]{0,8}([^\s"'`#,;&|<>(){}[\]]{1,1024})/dg;
// `--password S3cret` (flag, space, value).
const FLAG_VALUE_RE = /(?:^|[ \t])--?([A-Za-z][\w-]{0,40})[ \t]{1,8}([^\s"'`#;&|<>(){}[\]-][^\s"'`#;&|<>(){}[\]]{0,1023})/dg;
// What lets a whole line be skipped: none of these, no assignment rule can fire.
const ASSIGN_HINT_RE = /pass|pwd|secret|token|key|auth|cred|sign|salt|cookie|session|private|cert|mysql/i;

// Name components ("DB_PASSWORD_PROD" → db, password, prod) that make the
// value the secret itself.
const SECRET_WORD_RE = /^(?:password|passwd|passphrase|pwd|secret|secrets|token|apikey|credentials?)$/;
// Run-together names ("dbpassword", "githubtoken", "awssecretkey").
const SECRET_SUFFIX_RE = /(?:password|passwd|passphrase|secret|token|apikey|(?:secret|access|private|auth|signing|encryption|client|master|account)key)$/;
// "<qualifier> key" pairs ("API_KEY", "accessKey", "SIGNING_KEY_PROD").
const KEY_QUALIFIERS = new Set(["api", "secret", "access", "private", "auth", "signing", "encryption", "client", "master", "account", "service"]);
// A last component saying the value is about a secret, not the secret.
const NOT_SECRET_LAST = new Set([
  "hash", "hashed", "digest", "checksum", "fingerprint", "id", "ids", "name", "names", "path", "paths", "file", "files",
  "dir", "url", "uri", "endpoint", "host", "type", "length", "len", "size", "min", "max", "count", "limit", "timeout", "ttl",
  "expiry", "expires", "expiration", "header", "field", "policy", "prompt", "label", "arn", "ref", "env", "var", "version",
  "format", "mode", "algorithm", "alg", "scope", "scopes", "enabled", "required", "regex", "pattern", "hint", "provider",
  "store", "manager", "prefix", "rate", "stdin",
]);
// Looser: names that merely suggest a secret. Only very high-entropy values count here.
const SECRETISH_NAME_RE = /key|secret|token|passw|pwd|auth|credential|signature|salt|cookie|session|private|cert/i;
const NOT_SECRET_ANYWHERE_RE = /public|hash|checksum|digest/i;
const PLACEHOLDER_RE = /example|placeholder|changeme|change_me|your[_-]?|dummy|redacted|sample|fake|test|xxxx|\*\*\*|<|>|\{\{|\$\{|%\(/i;
const DATA_URI_RE = /data:[\w/+.-]{1,100};base64,[A-Za-z0-9+/=]+/g;
const HEX_RE = /^(?:[0-9a-f]+|[0-9A-F]+)$/;

function isMixedCase(s) {
  return /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
}

function isPlaceholder(v) {
  return PLACEHOLDER_RE.test(v) || /^(.)\1*$/.test(v) || /^[$%]/.test(v);
}

function isBase64PrivateKey(b64) {
  const head = b64.slice(0, b64.length - (b64.length % 4));
  const text = Buffer.from(head, "base64").toString("latin1");
  return /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY/.test(text);
}

/** Shannon entropy in bits per character. */
function shannon(s) {
  if (!s) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  const n = s.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

// Hex can never pass 4.0 bits/char (16 symbols), and a random 32+ char hex
// string sits around 3.5–3.9, so it gets its own floor.
const entropyFloor = v => (HEX_RE.test(v) ? 3.0 : 4.0);

// References to secrets are not secrets: env-var names, dotted config paths.
function isReference(v) {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v) || v.includes("://");
}

function nameParts(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(p => p.replace(/\d+$/, ""))
    .filter(Boolean);
}

function isSecretName(name) {
  const parts = nameParts(name);
  if (!parts.length || NOT_SECRET_LAST.has(parts[parts.length - 1])) return false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (SECRET_WORD_RE.test(p) || SECRET_SUFFIX_RE.test(p)) return true;
    // "DB_PASS", "SMTP_PASS"; but not "renderPassIndex" or "PASS_COUNT".
    if (p === "pass" && i === parts.length - 1) return true;
    if ((p === "key" || p === "keys") && i > 0 && KEY_QUALIFIERS.has(parts[i - 1])) return true;
  }
  return false;
}

// Lookup keys rather than credentials: "cacheKey", "PARTITION_KEY", "sortKey".
const LOOKUP_KEY_PARTS = new Set(["cache", "storage", "primary", "partition", "sort", "foreign", "idempotency", "dedupe", "lookup"]);

function isSecretishName(name) {
  const parts = nameParts(name);
  if (!SECRETISH_NAME_RE.test(name) || !parts.length) return false;
  return !NOT_SECRET_LAST.has(parts[parts.length - 1]) && !parts.some(p => LOOKUP_KEY_PARTS.has(p));
}

function mask(secret) {
  const keep = secret.length >= 20 ? 4 : secret.length >= 12 ? 2 : 0;
  return secret.slice(0, keep) + "****";
}

const clip = s => (s.length > 40 ? s.slice(0, 39) + "…" : s);

/**
 * Classify `name = value`; null when it does not look like a secret.
 * The generic entropy rule needs a quoted value or a line-leading
 * assignment (`KEY=…`, `- KEY=…`, `key: …`): a `key: value` pair in the
 * middle of a log line is mostly CI chatter (cache keys, digests).
 */
function classifyAssignment(name, value, { quoted = false, leading = false } = {}) {
  if (NOT_SECRET_ANYWHERE_RE.test(name) || isPlaceholder(value) || isReference(value)) return null;
  // Base64 PEM: the private-key rule already judged it (certificates pass).
  if (value.startsWith("LS0tLS1CRUdJTi")) return null;
  if (isSecretName(name) && value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value) && shannon(value) >= 3.0) {
    return "secret_assignment";
  }
  if (
    (quoted || leading) &&
    isSecretishName(name) &&
    value.length >= 32 &&
    !/^sha(?:256|384|512)-/i.test(value) &&
    shannon(value) >= entropyFloor(value)
  ) {
    return "high_entropy_string";
  }
  return null;
}

// Only indentation, a YAML/compose list dash, `export` or an opening quote
// before the name, and nothing but a comment or `;` after the value.
const LEADING_BEFORE_RE = /^[ \t]*(?:-[ \t]+)?(?:(?:export|set|setenv)[ \t]+)?["']?$/;
const LEADING_AFTER_RE = /^["']?[ \t]*(?:[#;].*)?$/;

function scanLine(line, lineNo, out) {
  // Base64 payloads (inline images, fonts) are noise; blank them out in place
  // so offsets stay valid for the overlap check below.
  if (line.includes(";base64,")) line = line.replace(DATA_URI_RE, m => " ".repeat(m.length));

  const spans = [];
  const overlaps = (a, b) => spans.some(([s, e]) => a < e && b > s);
  for (const rule of TOKEN_RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(line))) {
      if (rule.check && !rule.check(m)) continue;
      const secret = rule.secretGroup ? m[rule.secretGroup] : m[0];
      const preview = rule.preview
        ? rule.preview(m)
        : rule.header
          ? m[0]
          : rule.secretGroup
            ? m[0].slice(0, m[0].indexOf(secret)) + mask(secret)
            : mask(secret);
      spans.push([m.index, m.index + m[0].length]);
      out.push({ type: rule.type, line: lineNo, preview: clip(preview) });
    }
  }

  if (!ASSIGN_HINT_RE.test(line)) return;
  const report = (type, start, value, preview) => {
    if (overlaps(start, start + value.length)) return;
    spans.push([start, start + value.length]);
    out.push({ type, line: lineNo, preview: clip(preview) });
  };
  const consider = (name, value, valueStart, opts) => {
    if (overlaps(valueStart, valueStart + value.length)) return;
    const type = classifyAssignment(name, value, opts);
    if (type) report(type, valueStart, value, `${name}=${mask(value)}`);
  };

  let m;
  AUTH_HEADER_RE.lastIndex = 0;
  while ((m = AUTH_HEADER_RE.exec(line))) {
    const value = m[1];
    if (isPlaceholder(value) || isReference(value) || !/[A-Za-z]/.test(value)) continue;
    if (!/\d/.test(value) && value.length < 20) continue;
    report("auth_header", m.indices[1][0], value, `Authorization: ${mask(value)}`);
  }

  COOKIE_HEADER_RE.lastIndex = 0;
  while ((m = COOKIE_HEADER_RE.exec(line))) {
    const rest = line.slice(m.index + m[0].length, m.index + m[0].length + 8000);
    const base = m.index + m[0].length;
    COOKIE_PAIR_RE.lastIndex = 0;
    let c;
    while ((c = COOKIE_PAIR_RE.exec(rest))) {
      const [, name, value] = c;
      if (!SESSION_COOKIE_RE.test(name) || value.length < 16 || isPlaceholder(value) || shannon(value) < 3.0) continue;
      report("session_cookie", base + c.indices[2][0], value, `${name}=${mask(value)}`);
    }
  }

  MYSQL_P_RE.lastIndex = 0;
  while ((m = MYSQL_P_RE.exec(line))) {
    if (!isPlaceholder(m[1])) report("secret_assignment", m.indices[1][0], m[1], `mysql -p${mask(m[1])}`);
  }

  QUOTED_ASSIGN_RE.lastIndex = 0;
  while ((m = QUOTED_ASSIGN_RE.exec(line))) {
    consider(m[2], m[4], m.indices[4][0], { quoted: true });
  }

  BARE_ASSIGN_RE.lastIndex = 0;
  while ((m = BARE_ASSIGN_RE.exec(line))) {
    const [nameStart] = m.indices[1];
    const [valueStart, valueEnd] = m.indices[2];
    const before = line.slice(0, nameStart).replace(/--?$/, "");
    const leading = LEADING_BEFORE_RE.test(before) && LEADING_AFTER_RE.test(line.slice(valueEnd));
    consider(m[1], m[2], valueStart, { leading });
  }

  FLAG_VALUE_RE.lastIndex = 0;
  while ((m = FLAG_VALUE_RE.exec(line))) {
    if (!isSecretName(m[1])) continue;
    consider(m[1], m[2], m.indices[2][0], {});
  }
}

/**
 * Find things that look like credentials.
 * @returns {Array<{type: string, line: number, preview: string}>} 1-based
 *   lines; previews are masked and never contain the whole secret.
 */
function scanText(text) {
  if (typeof text !== "string" || !text) return [];
  const findings = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) scanLine(lines[i], i + 1, findings);
  return findings;
}

// Deny rules over lower-cased path segments. `next` is the following segment,
// for the one two-segment rule (.docker/config.json).
const PATH_RULES = [
  { test: s => s.startsWith(".env") || s.endsWith(".env"), kind: "environment files" },
  { test: s => /\.(pem|key|p12|pfx)$/.test(s), kind: "key and certificate files" },
  { test: s => /^id_(rsa|dsa|ecdsa|ed25519)/.test(s), kind: "SSH keys" },
  { test: s => [".ssh", ".aws", ".gnupg", ".git", ".kube"].includes(s), dir: true },
  { test: s => [".npmrc", ".netrc", ".pypirc"].includes(s), kind: "credential config files" },
  { test: s => s.includes("keychain"), kind: "keychains" },
  { test: s => s.startsWith("credentials"), kind: "credential files" },
  { test: (s, next) => s === ".docker" && next === "config.json", kind: "Docker credential files", pair: true },
];

/**
 * Is this file allowed to leave the Mac? Pure string check; callers resolve
 * symlinks and check the real path too.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkPath(absPath) {
  if (typeof absPath !== "string" || !absPath || absPath.includes("\0") || !path.isAbsolute(absPath)) {
    return { ok: false, reason: "Use an absolute path" };
  }
  const segments = path.normalize(absPath).split(/[\\/]+/).filter(Boolean);
  const lower = segments.map(s => s.toLowerCase());
  for (let i = 0; i < lower.length; i++) {
    const rule = PATH_RULES.find(r => r.test(lower[i], lower[i + 1]));
    if (!rule) continue;
    if (rule.dir) return { ok: false, reason: `Router never sends files from ${segments[i]}/ because it can hold secrets` };
    const name = rule.pair ? `${segments[i]}/${segments[i + 1]}` : segments[i];
    return { ok: false, reason: `Router never sends ${name}: ${rule.kind} can hold secrets` };
  }
  return { ok: true };
}

module.exports = { scanText, checkPath, shannon };
