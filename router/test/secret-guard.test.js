"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { scanText, checkPath, shannon } = require("../lib/secret-guard");

/*
 * The guard has two jobs that pull against each other: stop credentials from
 * reaching a volunteer's machine, and let ordinary logs and code through (a
 * false positive costs the user a premium call). Both directions are pinned.
 *
 * Fake secrets are generated at runtime so no token-shaped literal sits in
 * the repo for push-protection scanners to trip over.
 */

// Deterministic pseudo-random strings (mulberry32), so failures reproduce.
function gen(n, alphabet, seed = 7) {
  let a = seed >>> 0;
  let out = "";
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out += alphabet[Math.floor(r * alphabet.length)];
  }
  return out;
}
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const B62 = UPPER + LOWER + DIGITS;
const B64URL = B62 + "-_";
const b64url = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");

const SECRETS = {
  private_key: "-----BEGIN RSA PRIVATE KEY-----",
  aws_access_key: "AK" + "IA" + gen(16, UPPER + DIGITS, 3),
  github_token: "gh" + "p_" + gen(36, B62, 5),
  github_pat: "github" + "_pat_" + gen(40, B62 + "_", 9),
  openai_key: "s" + "k-" + gen(48, B62, 11),
  openai_project_key: "s" + "k-proj-" + gen(64, B64URL, 13),
  anthropic_key: "s" + "k-ant-api03-" + gen(90, B64URL, 17),
  slack_token: "xo" + "xb-" + gen(12, DIGITS, 19) + "-" + gen(13, DIGITS, 23) + "-" + gen(24, B62, 29),
  google_api_key: "AI" + "za" + gen(35, B64URL, 31),
  stripe_key: "s" + "k_live_" + gen(24, B62, 37),
  stripe_restricted: "r" + "k_live_" + gen(24, B62, 41),
  jwt: b64url({ alg: "HS256", typ: "JWT" }) + "." + b64url({ sub: "1234567890", name: "Ada", iat: 1516239022 }) + "." + gen(43, B64URL, 43),
};

function assertMasked(finding, secret) {
  assert.ok(finding.preview.length <= 40, `preview too long: ${finding.preview}`);
  assert.ok(!finding.preview.includes(secret), `preview leaks the secret: ${finding.preview}`);
}

const cases = [
  ["private_key", `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA${gen(40, B62)}\n-----END RSA PRIVATE KEY-----`, 1],
  ["aws_access_key", `aws_access_key_id = ${SECRETS.aws_access_key}`, SECRETS.aws_access_key],
  ["github_token", `git remote set-url origin https://x:${SECRETS.github_token}@github.com/o/r`, SECRETS.github_token],
  ["github_token", `GH_AUTH=${SECRETS.github_pat}`, SECRETS.github_pat],
  ["openai_key", `client = OpenAI(api_key="${SECRETS.openai_key}")`, SECRETS.openai_key],
  ["openai_key", `OPENAI_API_KEY=${SECRETS.openai_project_key}`, SECRETS.openai_project_key],
  ["anthropic_key", `export ANTHROPIC_API_KEY=${SECRETS.anthropic_key}`, SECRETS.anthropic_key],
  ["slack_token", `const slack = new WebClient("${SECRETS.slack_token}");`, SECRETS.slack_token],
  ["google_api_key", `<script src="https://maps.googleapis.com/maps/api/js?key=${SECRETS.google_api_key}"></script>`, SECRETS.google_api_key],
  ["stripe_key", `stripe.api_key = '${SECRETS.stripe_key}'`, SECRETS.stripe_key],
  ["stripe_key", `STRIPE_RESTRICTED=${SECRETS.stripe_restricted}`, SECRETS.stripe_restricted],
  ["jwt", `curl -H "Authorization: Bearer ${SECRETS.jwt}" http://localhost:3000/me`, SECRETS.jwt],
  ["secret_assignment", `DB_PASSWORD = "Xk9mP2vL7qR4"`, "Xk9mP2vL7qR4"],
  ["secret_assignment", `{ "api_key": "a8f3k2Lm9Qp7Rx4Tz" }`, "a8f3k2Lm9Qp7Rx4Tz"],
  ["secret_assignment", `  client_secret: 9fK2mQ7xL4pR8vT1`, "9fK2mQ7xL4pR8vT1"],
  ["secret_assignment", `export SECRET_KEY=8f3k2Lm9Qp7Rx4TzW`, "8f3k2Lm9Qp7Rx4TzW"],
  ["secret_assignment", `this.authToken = '${gen(40, "0123456789abcdef", 47)}';`, gen(40, "0123456789abcdef", 47)],
  ["high_entropy_string", `const sessionCookieValue = "${gen(44, B62 + "+/", 53)}";`, gen(44, B62 + "+/", 53)],
  ["url_credentials", `DATABASE_URL=postgres://app:Pq7xK2mZ9wLr@db.internal:5432/app`, "Pq7xK2mZ9wLr"],
];

for (const [type, line, secret] of cases) {
  test(`detects ${type}: ${line.slice(0, 48)}`, () => {
    // Bury the secret mid-file so the line number is meaningful.
    const text = ["first line", "second line", line, "last line"].join("\n");
    const findings = scanText(text);
    assert.ok(findings.length >= 1, `nothing found in: ${line}`);
    const f = findings.find(x => x.type === type);
    assert.ok(f, `expected ${type}, got ${JSON.stringify(findings)}`);
    assert.strictEqual(f.line, 3);
    if (typeof secret === "string") assertMasked(f, secret);
    for (const other of findings) if (typeof secret === "string") assertMasked(other, secret);
  });
}

// Credential shapes the first version of the guard let through (each of
// these returned [] and went out to a volunteer).
const HEX = "0123456789abcdef";
const b64 = s => Buffer.from(s).toString("base64");
const PEM_KEY_B64 = b64(`-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA${gen(200, B62, 71)}\n-----END RSA PRIVATE KEY-----\n`);
const OPENSSH_KEY_B64 = b64(`-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA${gen(200, B62, 73)}\n-----END OPENSSH PRIVATE KEY-----\n`);
const PEM_CERT_B64 = b64(`-----BEGIN CERTIFICATE-----\nMIIDBTCCAe2gAwIBAgIIb${gen(200, B62, 79)}\n-----END CERTIFICATE-----\n`);
const missed = [
  ["secret_assignment", "      - POSTGRES_PASSWORD=Kp9vR2mXq7Lw", "Kp9vR2mXq7Lw"],
  ["secret_assignment", "      - DB_PASS=Tr0ub4dor3xyzQ", "Tr0ub4dor3xyzQ"],
  ["secret_assignment", '  - "MYSQL_ROOT_PASSWORD=Kp9vR2mXq7Lw"', "Kp9vR2mXq7Lw"],
  ["secret_assignment", "SMTP_PASS=Tr0ub4dor3xyzQ", "Tr0ub4dor3xyzQ"],
  ["secret_assignment", "DB_PASSWORD_PROD=Xk9mP2vL7qR4", "Xk9mP2vL7qR4"],
  ["secret_assignment", "API_KEY_PROD=a8f3k2Lm9Qp7Rx4Tz", "a8f3k2Lm9Qp7Rx4Tz"],
  ["secret_assignment", "GITHUB_TOKEN_CI=a8f3k2Lm9Qp7Rx4Tz", "a8f3k2Lm9Qp7Rx4Tz"],
  ["secret_assignment", `SECRET_KEY_BASE="${gen(64, HEX, 83)}"`, gen(64, HEX, 83)],
  ["secret_assignment", `SECRET_KEY_BASE=${gen(64, HEX, 83)}`, gen(64, HEX, 83)],
  ["secret_assignment", "API_KEY=sk_abcDEF123456ghiJKL # prod", "sk_abcDEF123456ghiJKL"],
  ["secret_assignment", "DB_PASSWORD=Xk9mP2vL7qR4   # prod", "Xk9mP2vL7qR4"],
  ["secret_assignment", "export DB_PASSWORD=Xk9mP2vL7qR4;", "Xk9mP2vL7qR4"],
  ["secret_assignment", "mysql --password=Xk9mP2vL7qR4 -u root app", "Xk9mP2vL7qR4"],
  ["secret_assignment", "pg_dump --password Xk9mP2vL7qR4 app", "Xk9mP2vL7qR4"],
  ["secret_assignment", "mysql -u root -pXk9mP2vL7qR4 app < dump.sql", "Xk9mP2vL7qR4"],
  ["secret_assignment", "Started worker with token=a8f3k2Lm9Qp7Rx4Tz retries=3", "a8f3k2Lm9Qp7Rx4Tz"],
  ["high_entropy_string", `session_signing_salt: ${gen(48, B62 + "+/", 89)}`, gen(48, B62 + "+/", 89)],
  ["high_entropy_string", `const cookieSecretValue = "${gen(40, HEX, 97)}";`.replace("Secret", "Seal"), gen(40, HEX, 97)],
  ["private_key", `    client-key-data: ${PEM_KEY_B64}`, PEM_KEY_B64],
  ["private_key", `  tls.key: ${OPENSSH_KEY_B64}`, OPENSSH_KEY_B64],
  ["private_key", "PuTTY-User-Key-File-3: ssh-ed25519", 1],
  ["auth_header", `> Authorization: Bearer ${gen(40, HEX, 101)}`, gen(40, HEX, 101)],
  ["auth_header", `curl -H 'Authorization: Basic ${b64("deploy:" + gen(16, B62, 103))}' https://ci.internal/api`, b64("deploy:" + gen(16, B62, 103))],
  ["session_cookie", `> Cookie: theme=dark; session=${gen(32, B62, 107)}; lang=en`, gen(32, B62, 107)],
  ["session_cookie", `< Set-Cookie: connect.sid=s%3A${gen(40, B64URL, 109)}; Path=/; HttpOnly`, gen(40, B64URL, 109)],
  ["vault_token", `VAULT_TOKEN=hv${"s."}${gen(90, B64URL, 113)}`, gen(90, B64URL, 113)],
  ["gitlab_token", `git clone https://oauth2:gl${"pat-"}${gen(20, B62, 127)}@gitlab.com/g/p.git`, gen(20, B62, 127)],
  ["npm_token", `//registry.npmjs.org/:_authToken=np${"m_"}${gen(36, B62, 131)}`, gen(36, B62, 131)],
  ["huggingface_token", `huggingface-cli login --token h${"f_"}${gen(34, LOWER + UPPER, 137)}`, gen(34, LOWER + UPPER, 137)],
];

for (const [type, line, secret] of missed) {
  test(`detects ${type}: ${line.trim().slice(0, 48)}`, () => {
    const text = ["first line", "second line", line, "last line"].join("\n");
    const findings = scanText(text);
    const f = findings.find(x => x.type === type);
    assert.ok(f, `expected ${type}, got ${JSON.stringify(findings)}`);
    assert.strictEqual(f.line, 3);
    for (const other of findings) if (typeof secret === "string") assertMasked(other, secret);
  });
}

test("the compose file from the bug report is blocked on both lines", () => {
  const compose = [
    "services:",
    "  db:",
    "    image: postgres:16",
    "    environment:",
    "      - POSTGRES_USER=app",
    "      - POSTGRES_PASSWORD=Kp9vR2mXq7Lw",
    "      - DB_PASS=Tr0ub4dor3xyzQ",
    "    ports:",
    '      - "5432:5432"',
  ].join("\n");
  assert.deepStrictEqual(scanText(compose).map(f => [f.type, f.line]), [["secret_assignment", 6], ["secret_assignment", 7]]);
});

test("near misses of the new rules stay clean", () => {
  const text = [
    `    certificate-authority-data: ${PEM_CERT_B64}`,
    `    client-certificate-data: ${PEM_CERT_B64}`,
    "curl -H \"Authorization: Bearer $GITHUB_TOKEN\" https://api.github.com",
    'curl -H "Authorization: Bearer ${API_TOKEN}" https://example.com',
    "Authorization: Bearer <token>",
    "> Cookie: theme=dark; lang=en-US; tz=Europe/Berlin",
    "e.timestampWrites={beginningOfPassWriteIndex:this.pendingDispatchNumber*2,endOfPassWriteIndex:this.n*2+1}",
    "      - POSTGRES_USER=app",
    "      - PASS_COUNT=12",
    "docker login --password-stdin < /run/secrets/registry",
    "pg_dump --password-file /run/secrets/db.txt app",
    "password_hash=$2b$12$KIXQJ1e5hK9n0tM3r5Yb5uVj8Qy5bq7Hc4T2pYb0sQwXl9d6mZa3e",
    "SECRET_NAME=prod-db-password-2026",
    "token_count: 123456 prompt_tokens=8812 completion_tokens=512",
    "cache-key: node-modules-3f2a9c1b7e5d4c3b2a1f0e9d8c7b6a5f",
    "integrity sha512-" + gen(86, B62 + "+/", 59),
    "renderPass=pass1 bypass=on compass=north2",
  ].join("\n");
  assert.deepStrictEqual(scanText(text), []);
});

test("checkPath denies env files under any name", () => {
  assert.strictEqual(checkPath("/repo/config/app.env").ok, false);
  assert.strictEqual(checkPath("/repo/deploy/prod.ENV").ok, false);
  assert.deepStrictEqual(checkPath("/repo/docs/env.md"), { ok: true });
});

test("each secret is reported once, not once per overlapping rule", () => {
  const findings = scanText(`token = "${SECRETS.github_token}"`);
  assert.deepStrictEqual(findings.map(f => f.type), ["github_token"]);
});

test("private key preview shows the header, not key material", () => {
  const [f] = scanText(`-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA${gen(60, B62)}`);
  assert.strictEqual(f.type, "private_key");
  assert.strictEqual(f.line, 1);
  assert.strictEqual(f.preview, "-----BEGIN OPENSSH PRIVATE KEY-----");
});

test("reports every finding with its own line, across CRLF line endings", () => {
  const text = [`a=${SECRETS.aws_access_key}`, "ok", "ok", `b=${SECRETS.stripe_key}`].join("\r\n");
  const findings = scanText(text);
  assert.deepStrictEqual(findings.map(f => [f.type, f.line]), [["aws_access_key", 1], ["stripe_key", 4]]);
});

test("a typical npm test log is clean", () => {
  const log = `
> koinos-router@0.1.0 test
> node --test router/test/

▶ auth tokens
  ✔ refresh token rotates after expiry (3.21ms)
  ✔ rejects an expired session token (0.84ms)
  ✖ password reset sends an email (12.5ms)
    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    + actual - expected

    + 'reset-link-sent'
    - 'reset-link-queued'
        at TestContext.<anonymous> (/Users/x/proj/test/auth.test.js:42:12)
        at async Test.run (node:internal/test_runner/test:797:9)
▶ auth tokens (18.9ms)
PASS src/secret-store.test.js (4.2 s)
  ● Auth › token: expected "abc" received "def"
Using cache key: npm-cache-darwin-arm64-3f2a9c1b7e5d4c3b
cache-key: npm-darwin-arm64-3f2a9c1b7e5d4c3b2a1f
max_tokens: 512
tokenizer: cl100k_base
  "cacheKey": "npm-darwin-arm64-3f2a9c1b7e5d4c3b2a1f0e9d8c"
ℹ tests 3
ℹ pass 2
ℹ fail 1
ℹ duration_ms 214.512
npm ERR! code ELIFECYCLE
npm ERR! errno 1
npm ERR! koinos-router@0.1.0 test: \`node --test router/test/\`
`;
  assert.deepStrictEqual(scanText(log), []);
});

test("a git log with 40-char hashes is clean", () => {
  const log = `commit 9fceb02d0ae598e95dc970b74767f19372d61af8 (HEAD -> main, origin/main)
Author: Jane Doe <jane@example.com>
Date:   Tue Oct 6 14:02:11 2026 -0700

    Rotate session token signing key handling

    Change-Id: I8f3a1c2b9d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a
    Signed-off-by: Jane Doe <jane@example.com>

commit 3f2a9c1b7e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b
Merge: 1a2b3c4 5d6e7f8
Author: Sam <sam@example.com>

    Merge pull request #42 from team/fix-auth-key-rotation
diff --git a/src/auth.js b/src/auth.js
index 83db48f..bf269f4 100644
--- a/src/auth.js
+++ b/src/auth.js
-  const token = readToken();
+  const token = await readToken({ refresh: true });
`;
  assert.deepStrictEqual(scanText(log), []);
});

test("UUIDs are clean, even next to secret-ish names", () => {
  const text = [
    "request_id=550e8400-e29b-41d4-a716-446655440000",
    `{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","session":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}`,
    `const sessionId = "c0a8012e-7f3b-4c2d-9e1a-5b6d7c8e9f00";`,
    "trace 6ba7b810-9dad-11d1-80b4-00c04fd430c8 finished in 12ms",
  ].join("\n");
  assert.deepStrictEqual(scanText(text), []);
});

test("a minified JS line is clean", () => {
  const line =
    '!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?module.exports=t():"function"==typeof define&&define.amd?define(t):(e="undefined"!=typeof globalThis?globalThis:e||self).Lib=t()}(this,function(){"use strict";' +
    'var e={token:null,apiKey:"",secret:void 0,password:""},t=function(t,n){return e.token=t,e.apiKey=n.apiKey||"",fetch("/api/session",{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},' +
    'body:JSON.stringify({key:n.key,sessionId:"c0a8012e-7f3b-4c2d-9e1a-5b6d7c8e9f00",prefix:"sk-"+n.id})})};' +
    'return{auth:t,version:"3.14.159",hash:"9fceb02d0ae598e95dc970b74767f19372d61af8",integrity:"sha512-' + gen(86, B62 + "+/", 59) + '==",' +
    'tokenKey:"__auth_token__",storageKey:"app.session.v2",logo:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA' + gen(4000, B62 + "+/", 61) + '="}});';
  assert.deepStrictEqual(scanText(line), []);
});

test("ordinary code that mentions secrets without containing one is clean", () => {
  const code = `
const apiKey = process.env.OPENAI_API_KEY;
const token = getToken();
password = "changeme"
api_key: "\${API_KEY}"
secret: "your-secret-here"
DB_PASSWORD=
GITHUB_TOKEN=\${{ secrets.GITHUB_TOKEN }}
const PASSWORD_MIN_LENGTH = 12;
if (password.length < 8) throw new Error("password too short");
publicKey: "${gen(64, B62, 67)}"
const secretName = "prod/db/password";
token_url = "https://oauth2.googleapis.com/token"
token: "test-token-123"
mysql://user:\${DB_PASS}@localhost/app
`;
  assert.deepStrictEqual(scanText(code), []);
});

test("empty and non-string input scan clean", () => {
  assert.deepStrictEqual(scanText(""), []);
  assert.deepStrictEqual(scanText(undefined), []);
  assert.deepStrictEqual(scanText(null), []);
});

test("a long pathological line scans quickly", () => {
  const started = Date.now();
  scanText("a".repeat(500_000) + " password");
  scanText("token=" + "x-".repeat(250_000));
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
});

test("shannon entropy separates hex hashes from random base64", () => {
  assert.ok(shannon("9fceb02d0ae598e95dc970b74767f19372d61af8") < 4.0);
  assert.ok(shannon(gen(44, B62 + "+/", 53)) >= 4.0);
  assert.strictEqual(shannon(""), 0);
  assert.strictEqual(shannon("aaaa"), 0);
});

// ---- checkPath ----

const denied = [
  "/Users/x/proj/.env",
  "/Users/x/proj/.env.local",
  "/Users/X/Proj/.ENV.production",
  "/Users/x/proj/.envrc",
  "/Users/x/.ssh/config",
  "/Users/x/.ssh",
  "/Users/x/proj/config/credentials.json",
  "/Users/x/.aws/credentials",
  "/Users/x/.aws/config",
  "/Users/x/proj/certs/server.pem",
  "/Users/x/proj/tls/server.KEY",
  "/Users/x/certs/client.p12",
  "/Users/x/certs/client.PFX",
  "/Users/x/backup/id_rsa",
  "/Users/x/backup/id_rsa.pub",
  "/Users/x/backup/id_ed25519",
  "/Users/x/backup/id_ecdsa_sk",
  "/Users/x/.gnupg/pubring.kbx",
  "/Users/x/proj/.git/config",
  "/Users/x/proj/.GIT/HEAD",
  "/Users/x/.npmrc",
  "/Users/x/.netrc",
  "/Users/x/.pypirc",
  "/Users/x/Library/Keychains/login.keychain-db",
  "/Users/x/.docker/config.json",
  "/Users/x/.kube/config",
  "/Users/x/proj/logs/../../.ssh/id_ed25519",
];

for (const p of denied) {
  test(`checkPath denies ${p}`, () => {
    const r = checkPath(p);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /never sends/);
  });
}

const allowed = [
  "/Users/x/proj/logs/test.log",
  "/Users/x/proj/src/index.js",
  "/Users/x/proj/.gitignore",
  "/Users/x/proj/.github/workflows/ci.yml",
  "/Users/x/proj/docs/environment.md",
  "/Users/x/proj/src/keys.js",
  "/Users/x/proj/src/credential-helper.js",
  "/Users/x/proj/src/id_utils.js",
  "/Users/x/proj/monkey.txt",
  "/Users/x/.docker/daemon.json",
  "/Users/x/proj/.ssh-notes.md",
];

for (const p of allowed) {
  test(`checkPath allows ${p}`, () => {
    assert.deepStrictEqual(checkPath(p), { ok: true });
  });
}

test("checkPath names the offending file in its reason", () => {
  assert.match(checkPath("/Users/x/proj/.env.local").reason, /\.env\.local/);
  assert.match(checkPath("/Users/x/.ssh/config").reason, /\.ssh\//);
  assert.match(checkPath("/Users/x/.docker/config.json").reason, /\.docker\/config\.json/);
});

test("checkPath requires an absolute path", () => {
  for (const p of ["proj/.env", "./logs/test.log", "logs/test.log", "~/logs/test.log", "", null, undefined, 42, "/Users/x/a\0b"]) {
    assert.deepStrictEqual(checkPath(p), { ok: false, reason: "Use an absolute path" }, String(p));
  }
});
