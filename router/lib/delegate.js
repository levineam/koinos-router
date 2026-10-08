"use strict";

const fs = require("fs");
const path = require("path");
const { scanText, checkPath } = require("./secret-guard");

/*
 * Delegate engine: one `delegate` tool call → one or more network jobs.
 *
 *   limits → args → paths → read → secret scan → price → chunk → queue → map/reduce
 *
 * Every refusal we can make locally happens before the first byte leaves the
 * Mac, and nothing is sent once the secret scan has a finding. The limit
 * checks run again right before each network call, because a map-reduce run
 * spends as it goes and the user can switch Use KoinosAI off mid-run.
 *
 * The scheduler allows one in-flight consume request per wallet, so all
 * network calls go through one FIFO queue with concurrency 1. A run holds the
 * queue from its first call to its last: interleaving the calls of two
 * map-reduce runs would make both of them slow enough to time out.
 */

const CODES = [
  "OUT_OF_KAI",
  "DAILY_LIMIT",
  "TOO_LARGE",
  "BLOCKED_SECRET",
  "BLOCKED_PATH",
  "NETWORK_BUSY",
  "TIMEOUT",
  "PAUSED",
  "BAD_INPUT",
  "NETWORK_ERROR",
  "CANCELLED",
];

// The gateway refuses a network prompt that leaves less than this free in the
// context window (gateway CTX_HEADROOM_TOKENS); it is also our answer cap.
const OUTPUT_TOKENS = 512;
// The chat template around each message (<|im_start|>role ... <|im_end|>) and
// the gateway's own 4-per-message allowance; the prompt text itself is
// estimated in full (see estimateTokens).
const TEMPLATE_TOKENS = 32;
const MIN_INPUT_TOKENS = 64; // below this a chunk can't hold a useful slice of input
const MAX_TASK_CHARS = 4000;
const SNIFF_BYTES = 8192;
const DEFAULT_CTX_TOKENS = 4096;
// Partial answers that add up to no more than this go back to the agent as
// labelled parts instead of through a reduce call: a 1.5B–7B model asked to
// combine counts gets the arithmetic wrong, and the agent can add.
const PASSTHROUGH_TOKENS = 1024;
// A second Mac on the same wallet can hold the scheduler's one consume slot
// for a few seconds; wait for it rather than fail the delegation.
const WALLET_BUSY_RE = /still running|already in flight|earlier request/i;
const WALLET_BUSY_BACKOFF_MS = [500, 1000, 2000, 4000];
const FALLBACK_MODEL = "koinos-network";
const MAX_ECHO = 200;

const DO_IT_YOURSELF = "Do this task yourself instead.";

const SYSTEM_PROMPT =
  "You are a helper doing one bounded task for a coding agent. " +
  "Reply with the result only: no preamble, no questions, no offers of more help. " +
  "Be concise. Work only from the input you are given and never invent file contents.";

const FORMAT_LINES = {
  text: "",
  markdown: "Respond in Markdown only.",
  json: "Respond with valid JSON only.",
};

const HINTS = {
  OUT_OF_KAI: `The user can earn KAI by turning on Share compute in Koinos Router. ${DO_IT_YOURSELF}`,
  DAILY_LIMIT: `The limit resets at midnight. ${DO_IT_YOURSELF}`,
  TOO_LARGE: "Narrow the input (fewer files, an excerpt or a filtered log) or split the work into smaller delegations.",
  BLOCKED_SECRET: "Remove the secret from the input, or do this task yourself.",
  BLOCKED_PATH: "Leave that file out, or do this task yourself.",
  NETWORK_BUSY: DO_IT_YOURSELF,
  TIMEOUT: DO_IT_YOURSELF,
  PAUSED: DO_IT_YOURSELF,
  BAD_INPUT: "Fix the arguments and call delegate again.",
  NETWORK_ERROR: DO_IT_YOURSELF,
  CANCELLED: "",
};

const SECRET_LABELS = {
  private_key: "private key",
  aws_access_key: "AWS access key",
  github_token: "GitHub token",
  openai_key: "OpenAI API key",
  anthropic_key: "Anthropic API key",
  slack_token: "Slack token",
  google_api_key: "Google API key",
  stripe_key: "Stripe key",
  jwt: "JWT",
  url_credentials: "password in a URL",
  secret_assignment: "hard-coded secret",
  high_entropy_string: "high-entropy secret",
  auth_header: "Authorization header",
  session_cookie: "session cookie",
  gitlab_token: "GitLab token",
  npm_token: "npm token",
  vault_token: "Vault token",
  huggingface_token: "Hugging Face token",
};

const PAUSED_MESSAGE = "Use KoinosAI is turned off in Koinos Router.";

class DelegateError extends Error {
  constructor(code, message, hint = "") {
    super(message);
    this.name = "DelegateError";
    this.code = code;
    this.hint = hint;
  }
}

const fail = (code, message, hint = HINTS[code]) => new DelegateError(code, message, hint);
const badInput = message => fail("BAD_INPUT", message);

function clip(s, n = MAX_ECHO) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function sentence(s) {
  const str = String(s ?? "").trim();
  return !str || /[.!?…]$/.test(str) ? str : `${str}.`;
}

function duration(ms) {
  if (ms < 1000) return `${ms} ms`;
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`;
}

function bytes(n) {
  if (n >= 1024 * 1024) return `${+(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} bytes`;
}

const thousands = n => Math.round(n).toLocaleString("en-US");

/** Same estimate as core/lib/gateway.js estimateMessageTokens (~4 chars per
 *  token + 4 per message), copied so our budgets match the gate the gateway
 *  applies before buying network tokens. Text only: delegations never carry
 *  images. */
function estimateMessageTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  let n = 0;
  for (const m of messages) {
    n += 1;
    const c = m?.content;
    if (Array.isArray(c)) {
      for (const part of c) chars += String(part?.text ?? "").length;
    } else {
      chars += String(c ?? "").length;
    }
  }
  return Math.ceil(chars / 4) + n * 4;
}

const tokens = chars => Math.ceil(chars / 4);

/*
 * Conservative token count for text bound for a network worker.
 *
 * chars/4 is the gateway's gate, not the truth: the network runs Qwen 2.5,
 * whose tokenizer gives every digit its own token, so a CI log is ~1.7 chars
 * per token, a CSV ~1, base64 ~1.3 and CJK ~1.8. Budgeting at chars/4 sent
 * prompts that were 50–100% over the workers' 4,096-token context, and the
 * worker dropped them. This estimate was calibrated against the real Qwen 2.5
 * tokenizer (llama-tokenize) on logs, CSV, JSON, code, prose, minified JS,
 * hex, base64, CJK and emoji, and came out at or above the real count on
 * every sample (1.03–1.6x; prose and code pay the most). It is never below
 * the gateway's own chars/4, so a prompt that fits here passes the gate too.
 * The estimate is additive over line-aligned pieces, which chunking relies on.
 */
const isUpper = c => c >= 65 && c <= 90;
const isLower = c => c >= 97 && c <= 122;
const isDigit = c => c >= 48 && c <= 57;
const isB64 = c => isUpper(c) || isLower(c) || isDigit(c) || c === 43 || c === 47 || c === 61;
const VOWEL_RE = /[aeiouyAEIOUY]/;
const WORD_RE = /^[A-Z]?[a-z]+$/;
const CAPS_RE = /^[A-Z]+$/;
// Most a single character can cost (non-ASCII symbol, ×1.05, rounding); used
// to hard-split a long line into pieces that are guaranteed to fit.
const MAX_TOKENS_PER_CHAR = 1.6;

function segmentTokens(s) {
  const n = s.length;
  if (n <= 2) return 1;
  if (!VOWEL_RE.test(s)) return Math.ceil(n / 2); // consonant runs: random IDs, abbreviations
  if (WORD_RE.test(s)) return Math.ceil(n / 6); // a word: usually one token
  if (CAPS_RE.test(s)) return Math.ceil(n / 3);
  return Math.ceil(n / 2);
}

// A letter run split at case changes ("estimateMessageTokens" → 3 words).
function letterTokens(text, i, j) {
  let t = 0;
  let start = i;
  for (let k = i + 1; k <= j; k++) {
    const a = text.charCodeAt(k - 1);
    const b = k < j ? text.charCodeAt(k) : 0;
    const cut = k === j || (isLower(a) && isUpper(b)) || (isUpper(a) && isUpper(b) && k + 1 < j && isLower(text.charCodeAt(k + 1)));
    if (cut) {
      t += segmentTokens(text.slice(start, k));
      start = k;
    }
  }
  return t;
}

function estimateTokens(text) {
  const str = String(text ?? "");
  const n = str.length;
  let t = 0;
  let i = 0;
  while (i < n) {
    const c = str.charCodeAt(i);
    if (isUpper(c) || isLower(c) || isDigit(c)) {
      // Mixed-case alphanumeric blobs (base64, keys, hashes): ~0.75 tokens/char.
      let j = i;
      let up = 0;
      let lo = 0;
      let dg = 0;
      while (j < n) {
        const d = str.charCodeAt(j);
        if (!isB64(d)) break;
        if (isUpper(d)) up++;
        else if (isLower(d)) lo++;
        else if (isDigit(d)) dg++;
        j++;
      }
      if (j - i >= 16 && dg && up && lo) {
        t += Math.ceil((j - i) * 0.8);
        i = j;
        continue;
      }
    }
    if (isUpper(c) || isLower(c)) {
      let j = i;
      while (j < n && (isUpper(str.charCodeAt(j)) || isLower(str.charCodeAt(j)))) j++;
      t += letterTokens(str, i, j);
      i = j;
    } else if (isDigit(c)) {
      t += 1;
      i++;
    } else if (c === 32 || c === 9) {
      let j = i;
      while (j < n && (str.charCodeAt(j) === 32 || str.charCodeAt(j) === 9)) j++;
      t += j - i === 1 ? 0 : Math.ceil((j - i) / 8); // one space rides on the next word
      i = j;
    } else if (c < 128) {
      t += 1; // punctuation, newlines
      i++;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      t += 3; // astral (emoji): several byte-level tokens
      i += 2;
    } else {
      // CJK, kana and hangul run ~0.6 tokens/char; other symbols cost more.
      t += (c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) ? 0.75 : 1.5;
      i++;
    }
  }
  return Math.max(Math.ceil(t * 1.05), tokens(n));
}

// ---- errors from the network side ----

function isTimeoutLike(err) {
  return (
    err?.name === "AbortError" ||
    err?.name === "TimeoutError" ||
    err?.code === "ETIMEDOUT" ||
    /time ?out|timed out/i.test(String(err?.message || ""))
  );
}

/** Map a chat()/pricing() failure onto a delegate code (order per contract). */
function mapNetworkError(err) {
  if (err instanceof DelegateError) return err;
  const status = Number(err?.status) || 0;
  const message = String(err?.message ?? err ?? "");
  if (status === 402) return fail("OUT_OF_KAI", "The Koinos Router balance is out of KAI.");
  if (status === 409 || status === 503 || /no providers|busy|capacity/i.test(message)) {
    return fail("NETWORK_BUSY", "The KoinosAI network has no free capacity right now.");
  }
  if (isTimeoutLike(err)) return fail("TIMEOUT", "The network did not answer in time.");
  if (status === 400 && /Local-Only/i.test(message)) return fail("PAUSED", PAUSED_MESSAGE);
  const what = status ? `The network request failed (HTTP ${status})` : "The network request failed";
  return fail("NETWORK_ERROR", message.trim() ? `${what}: ${sentence(clip(message))}` : `${what}.`);
}

/** Settle with `promise`, or reject with makeError() as soon as `signal`
 *  aborts — even when the promise ignores the signal and never settles. */
function raceAbort(promise, signal, makeError) {
  if (signal.aborted) return Promise.reject(makeError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(makeError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

// ---- the shared queue ----

/** FIFO, one job at a time. A waiting job leaves the line as soon as its
 *  run is aborted, so a timed-out run never holds up the runs behind it. */
class SerialQueue {
  constructor() {
    this.waiting = [];
    this.busy = false;
  }

  get size() {
    return this.waiting.length + (this.busy ? 1 : 0);
  }

  push(fn, signal, abortError) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const job = { fn, resolve, reject, signal };
      job.onAbort = () => {
        const i = this.waiting.indexOf(job);
        if (i < 0) return; // already running: the job watches the signal itself
        this.waiting.splice(i, 1);
        reject(abortError());
      };
      signal.addEventListener("abort", job.onAbort, { once: true });
      this.waiting.push(job);
      this._next();
    });
  }

  _next() {
    if (this.busy) return;
    const job = this.waiting.shift();
    if (!job) return;
    job.signal.removeEventListener("abort", job.onAbort);
    this.busy = true;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.busy = false;
        this._next();
      });
  }
}

// ---- chunking ----

/** Lines with their terminators; a line that costs more than `room` is
 *  hard-split into pieces that each cost at most `room`. */
function* pieces(text, room, cost) {
  if (!text) {
    yield "(empty)\n";
    return;
  }
  const width = Math.max(1, Math.floor((room - 1) / MAX_TOKENS_PER_CHAR));
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl + 1;
    let i = start;
    if (end - i > width && cost(text.slice(i, end)) > room) {
      while (end - i > width) {
        let cut = i + width;
        const c = text.charCodeAt(cut - 1);
        if (c >= 0xd800 && c <= 0xdbff && cut - i > 1) cut -= 1; // never split a surrogate pair
        yield text.slice(i, cut);
        i = cut;
      }
    }
    if (i < end) yield text.slice(i, end);
    start = end;
  }
}

/**
 * Pack labelled inputs into chunks that each cost at most `budget`,
 * breaking only at line ends (a line longer than a chunk is hard-split).
 * Each input starts with a `### <label>` line, repeated as
 * `### <label> (continued)` when the input runs over into a new chunk.
 * Stops early once it has more than `limit` chunks.
 * @param {Array<{label: string, text: string}>} inputs
 * @param {number} budget in units of `cost` (tokens by default)
 * @param {number} [limit]
 * @param {(s: string) => number} [cost] additive over line-aligned pieces
 * @returns {string[]}
 */
function chunkInputs(inputs, budget, limit = Infinity, cost = estimateTokens) {
  const chunks = [];
  let cur = "";
  let used = 0;
  const flush = () => {
    chunks.push(cur);
    cur = "";
    used = 0;
    return chunks.length <= limit;
  };
  for (const { label, text } of inputs) {
    const head = `### ${label}\n`;
    const cont = `### ${label} (continued)\n`;
    const headCost = cost(head);
    const contCost = cost(cont);
    const room = budget - contCost - cost("\n\n");
    if (room < 16) throw fail("TOO_LARGE", "The network's context is too small for this input.");
    let first = true;
    for (const piece of pieces(text, room, cost)) {
      const pieceCost = cost(piece);
      if (first) {
        first = false;
        const sep = cur ? (cur.endsWith("\n") ? "\n" : "\n\n") : "";
        const add = (sep ? cost(sep) : 0) + headCost + pieceCost;
        if (cur && used + add > budget) {
          if (!flush()) return chunks;
          cur = head + piece;
          used = headCost + pieceCost;
        } else {
          cur += sep + head + piece;
          used += add;
        }
      } else if (used + pieceCost > budget) {
        if (!flush()) return chunks;
        cur = cont + piece;
        used = contCost + pieceCost;
      } else {
        cur += piece;
        used += pieceCost;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Greedy groups of partial answers that fit one reduce prompt. */
function packAnswers(answers, budget, cost = estimateTokens) {
  const groups = [];
  let group = [];
  let used = 0;
  for (const answer of answers) {
    const price = cost(answer) + cost(reduceLabel(99)) + 2;
    if (group.length && used + price > budget) {
      groups.push(group);
      group = [];
      used = 0;
    }
    group.push(answer);
    used += price;
  }
  if (group.length) groups.push(group);
  return groups;
}

/** Shortest trailing path that tells each file apart ("web/package.json"),
 *  without sending the user's home path to a volunteer. */
function fileLabels(paths) {
  const parts = paths.map(p => p.split(/[\\/]+/).filter(Boolean));
  return parts.map((segs, i) => {
    for (let k = 1; k <= segs.length; k++) {
      const mine = segs.slice(-k).join("/");
      const clash = parts.some((other, j) => j !== i && other.slice(-k).join("/") === mine);
      if (!clash) return mine;
    }
    return segs.join("/");
  });
}

// ---- prompts ----

function mapPrompt(task, formatLine, chunk, part, parts) {
  const blocks = [task];
  if (formatLine) blocks.push(formatLine);
  if (parts > 1) blocks.push(`This is part ${part} of ${parts} of the input. Do the task on this part only.`);
  if (chunk) blocks.push(`Input:\n${chunk}`);
  return blocks.join("\n\n");
}

const reduceLabel = i => `Partial answer ${i}:\n`;

function reducePrompt(task, formatLine, answers) {
  const blocks = [`Task: ${task}`];
  if (formatLine) blocks.push(formatLine);
  blocks.push(
    "The input was split into separate, non-overlapping parts and the task was done on each part. " +
      "Combine these partial answers into one final answer. Add up counts and totals across all parts " +
      "(never copy one part's numbers as the total), keep every distinct item, and merge exact duplicates."
  );
  answers.forEach((answer, i) => blocks.push(`${reduceLabel(i + 1)}${answer}`));
  return blocks.join("\n\n");
}

/** The answers per part, for the agent to combine itself. */
function partsAnswer(answers) {
  const n = answers.length;
  const head = `The input was answered in ${n} separate parts; combine them (counts are per part).`;
  return [head, ...answers.map((a, i) => `Part ${i + 1} of ${n}:\n${a}`)].join("\n\n");
}

const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);

/** Deterministic merge of per-part JSON: arrays concatenate, numbers add,
 *  objects merge key by key. null when the parts don't line up. */
function mergeJson(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (isPlain(a) && isPlain(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (!Object.hasOwn(out, k)) out[k] = v;
      else {
        const m = mergeJson(out[k], v);
        if (m === undefined) return undefined;
        out[k] = m;
      }
    }
    return out;
  }
  if (a === b) return a;
  return undefined;
}

function mergeJsonAnswers(answers) {
  let acc;
  for (const [i, text] of answers.entries()) {
    let value;
    try {
      value = JSON.parse(stripFence(text));
    } catch {
      return null;
    }
    if (!Array.isArray(value) && !isPlain(value)) return null;
    acc = i === 0 ? value : mergeJson(acc, value);
    if (acc === undefined) return null;
  }
  return JSON.stringify(acc);
}

// Small models wrap JSON in a code fence even when told not to.
function stripFence(s) {
  const m = /^```[A-Za-z]*[ \t]*\n([\s\S]*?)\n?```$/.exec(s);
  return m ? m[1].trim() : s;
}

// ---- inputs ----

function validateArgs({ task, files, text, format }) {
  if (typeof task !== "string" || !task.trim()) throw badInput("task is required: say exactly what output you want.");
  if (task.length > MAX_TASK_CHARS) {
    throw badInput(`task is ${thousands(task.length)} characters; the limit is ${thousands(MAX_TASK_CHARS)}. Put long input in text or files.`);
  }
  const fileList = files ?? [];
  if (!Array.isArray(fileList) || fileList.some(f => typeof f !== "string" || !f)) {
    throw badInput("files must be a list of absolute file paths.");
  }
  const inline = text ?? "";
  if (typeof inline !== "string") throw badInput("text must be a string.");
  const fmt = format ?? "text";
  if (!Object.hasOwn(FORMAT_LINES, fmt)) throw badInput('format must be "text", "markdown" or "json".');
  return { task: task.trim(), files: fileList, text: inline, format: fmt };
}

function assertPathAllowed(file, protectedCheck) {
  if (!path.isAbsolute(file)) {
    throw fail("BLOCKED_PATH", `Use an absolute path (got "${clip(file, 100)}").`, "Pass every file as an absolute path.");
  }
  const verdict = checkPath(file);
  if (!verdict.ok) throw fail("BLOCKED_PATH", sentence(verdict.reason));
  const reason = protectedCheck(file);
  if (reason) throw fail("BLOCKED_PATH", sentence(reason));
}

// macOS and Windows file systems ignore case: ~/library is ~/Library.
const foldCase = process.platform === "darwin" || process.platform === "win32" ? s => s.toLowerCase() : s => s;

const within = (file, dir) => {
  const rel = path.relative(foldCase(dir), foldCase(path.resolve(file)));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Folders whose files never leave the Mac whatever their names, e.g. Router's
 * own data dir (wallet keystore, session and password blobs) and ~/Library.
 * @param {Array<{dir: string, reason: string, except?: string[]}>} rules
 * @returns {(file: string) => string|null} the refusal reason, or null
 */
function protectedPaths(rules = []) {
  const list = (Array.isArray(rules) ? rules : [])
    .filter(r => r && typeof r.dir === "string" && path.isAbsolute(r.dir))
    .map(r => ({ dirs: variants(r.dir), except: (r.except || []).flatMap(variants), reason: String(r.reason || "Router never sends files from that folder") }));
  return file => {
    for (const rule of list) {
      if (rule.dirs.some(d => within(file, d)) && !rule.except.some(d => within(file, d))) return rule.reason;
    }
    return null;
  };
}

// macOS reaches the same folder through /var and /private/var, /tmp and
// /private/tmp; callers pass a realpath too, so match both spellings.
function variants(dir) {
  const out = [path.resolve(dir)];
  try {
    const real = fs.realpathSync.native(dir);
    if (!out.includes(real)) out.push(real);
  } catch {
    // a folder that doesn't exist yet still guards its future contents
  }
  return out;
}

function normalizeHarness(h) {
  return h === "codex" || h === "claude" ? h : "other";
}

// The ledger is a local file, but a secret pasted into a task still doesn't
// belong in it.
function ledgerTask(task) {
  if (typeof task !== "string") return "";
  const flat = task.slice(0, 8000).replace(/\s+/g, " ").trim();
  if (scanText(flat).length) return "(withheld: the task looked like it contained a secret)";
  return clip(flat);
}

function normalizePrice(p) {
  const ctx = Number(p?.ctxTokens);
  const rate = v => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const ref = Number(p?.kaiRefUsd);
  return {
    ctxTokens: ctx > 0 ? Math.floor(ctx) : DEFAULT_CTX_TOKENS,
    inMicroPerM: rate(p?.inMicroPerM),
    outMicroPerM: rate(p?.outMicroPerM),
    kaiRefUsd: Number.isFinite(ref) && ref > 0 ? ref : null,
  };
}

const tokenCount = v => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** USD and KAI spent by a run so far. KAI is null when nothing was charged,
 *  and when the network gave no reference price: we never invent a rate. */
function costOf(run) {
  const p = run.price;
  if (!run.inTok && !run.outTok) return { usd: 0, kai: null };
  if (!p || p.inMicroPerM == null || p.outMicroPerM == null) return { usd: null, kai: null };
  const usd = (run.inTok * p.inMicroPerM + run.outTok * p.outMicroPerM) / 1e12;
  return { usd, kai: p.kaiRefUsd ? usd / p.kaiRefUsd : null };
}

class DelegateEngine {
  /**
   * @param {object} opts
   * @param {(req: {messages: object[], maxTokens: number, signal: AbortSignal}) => Promise<{content: string, usage?: object, servedModel?: string}>} opts.chat
   * @param {() => Promise<{ctxTokens: number, inMicroPerM: number, outMicroPerM: number, kaiRefUsd: number|null}>} opts.pricing
   * @param {{record: Function, spentToday: Function}} opts.ledger
   * @param {() => {enabled: boolean, dailyLimitKai: number|null}} opts.limits
   * @param {(p: string) => Promise<string>} [opts.realpath] resolves symlinks so a link can't smuggle a denied file out
   * @param {Array<{dir: string, reason: string, except?: string[]}>} [opts.protectedDirs] folders that never leave the Mac
   */
  constructor({
    chat,
    pricing,
    ledger,
    limits,
    readFile = p => fs.promises.readFile(p),
    stat = p => fs.promises.stat(p),
    realpath = p => fs.promises.realpath(p),
    now = () => Date.now(),
    maxChunks = 8,
    jobTimeoutMs = 60000,
    totalTimeoutMs = 180000,
    maxFileBytes = 2 * 1024 * 1024,
    protectedDirs = [],
    walletBusyBackoffMs = WALLET_BUSY_BACKOFF_MS,
    onEvent = () => {},
  } = {}) {
    if (typeof chat !== "function") throw new TypeError("DelegateEngine needs chat()");
    if (typeof pricing !== "function") throw new TypeError("DelegateEngine needs pricing()");
    if (!ledger || typeof ledger.record !== "function" || typeof ledger.spentToday !== "function") {
      throw new TypeError("DelegateEngine needs a ledger with record() and spentToday()");
    }
    if (typeof limits !== "function") throw new TypeError("DelegateEngine needs limits()");
    this.chat = chat;
    this.pricing = pricing;
    this.ledger = ledger;
    this.limits = limits;
    this.readFile = readFile;
    this.stat = stat;
    this.realpath = realpath;
    this.now = now;
    this.maxChunks = maxChunks;
    this.maxCalls = maxChunks * 2 + 2;
    this.jobTimeoutMs = jobTimeoutMs;
    this.totalTimeoutMs = totalTimeoutMs;
    this.maxFileBytes = maxFileBytes;
    this.walletBusyBackoffMs = walletBusyBackoffMs;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this._protected = protectedPaths(protectedDirs);
    this.queue = new SerialQueue();
    this._open = new Set(); // runs whose spend is not in the ledger yet
  }

  /**
   * @param {object} args
   * @param {AbortSignal} [args.signal] the caller gave up (the agent cancelled
   *   or disconnected): stop before the next network call → CANCELLED
   * @returns {Promise<{text: string, meta: {chunks: number, calls: number, model: string, kai: number|null, usd: number|null, inTok: number, outTok: number, combined: "parts"|"json"|"model"|null}>}>}
   *   meta.kai and meta.usd are the (positive) cost of this run.
   * @throws {DelegateError}
   */
  async run({ task, files = [], text = "", format = "text", harness = "other", signal } = {}) {
    const abort = new AbortController();
    const run = {
      harness: normalizeHarness(harness),
      task: ledgerTask(task),
      startedAt: this.now(),
      timeoutMs: this.totalTimeoutMs,
      signal: abort.signal,
      cancelled: false,
      timer: setTimeout(() => abort.abort(), this.totalTimeoutMs),
      price: null,
      chunks: 0,
      calls: 0,
      inTok: 0,
      outTok: 0,
      model: null,
      combined: null,
      error: null,
    };
    const cancel = () => {
      run.cancelled = true;
      abort.abort();
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener?.("abort", cancel, { once: true });
    this._open.add(run);
    try {
      if (run.cancelled) throw this._aborted(run);
      return await this._run(run, { task, files, text, format });
    } catch (err) {
      run.error =
        err instanceof DelegateError ? err : fail("NETWORK_ERROR", `Router hit an internal error: ${sentence(clip(err?.message ?? err))}`);
      if (run.cancelled && run.error.code === "TIMEOUT") run.error = this._aborted(run);
      throw run.error;
    } finally {
      clearTimeout(run.timer);
      signal?.removeEventListener?.("abort", cancel);
      this._finish(run);
    }
  }

  async _run(run, args) {
    await this._checkLimits();
    const input = validateArgs(args);
    for (const file of input.files) assertPathAllowed(file, this._protected);
    const docs = await this._readFiles(input.files);
    this._assertNoSecrets(input, docs);

    run.price = await this._price(run);
    const formatLine = FORMAT_LINES[input.format];
    const fixed = run.price.ctxTokens - OUTPUT_TOKENS - estimateTokens(SYSTEM_PROMPT) - TEMPLATE_TOKENS;
    const budgetTokens = fixed - estimateTokens(mapPrompt(input.task, formatLine, "", 99, 99)) - estimateTokens("\n\nInput:\n");
    const reduceBudget = fixed - estimateTokens(reducePrompt(input.task, formatLine, []));
    const sources = [];
    if (input.text) sources.push({ label: "Inline text", text: input.text });
    const labels = fileLabels(docs.map(d => d.path));
    docs.forEach((doc, i) => sources.push({ label: `File: ${labels[i]}`, text: doc.text }));
    const chunks = this._plan(sources, budgetTokens, run.price.ctxTokens);
    run.chunks = Math.max(1, chunks.length);

    // One run at a time on the network, from its first call to its last.
    const answer = await this.queue.push(
      async () => {
        if (chunks.length <= 1) return this._ask(run, mapPrompt(input.task, formatLine, chunks[0] || "", 1, 1));
        const partials = [];
        for (let i = 0; i < chunks.length; i++) {
          partials.push(await this._ask(run, mapPrompt(input.task, formatLine, chunks[i], i + 1, chunks.length)));
        }
        return this._combine(run, partials, input, formatLine, reduceBudget);
      },
      run.signal,
      () => this._aborted(run)
    );

    const { usd, kai } = costOf(run);
    return {
      text: input.format === "json" ? stripFence(answer) : answer,
      meta: {
        chunks: run.chunks,
        calls: run.calls,
        model: run.model || FALLBACK_MODEL,
        kai,
        usd,
        inTok: run.inTok,
        outTok: run.outTok,
        combined: run.combined,
      },
    };
  }

  /** PAUSED and DAILY_LIMIT; runs at the start and again before every call. */
  async _checkLimits() {
    const { enabled, dailyLimitKai } = this.limits() || {};
    if (enabled === false) throw fail("PAUSED", PAUSED_MESSAGE);
    if (typeof dailyLimitKai !== "number" || !Number.isFinite(dailyLimitKai)) return;
    // Runs in flight haven't reached the ledger yet, so count what they spent.
    // Read both in the same tick: across an await a run could move from
    // _open into the ledger and be missed by both.
    const recorded = this.ledger.spentToday();
    let spent = 0;
    for (const open of this._open) spent += costOf(open).kai || 0;
    spent += Number(await recorded) || 0;
    if (spent >= dailyLimitKai) {
      throw fail("DAILY_LIMIT", `Today's KoinosAI spending limit (${dailyLimitKai} KAI) has been reached.`);
    }
  }

  async _readFiles(files) {
    const docs = [];
    const seen = new Set();
    let total = 0;
    for (const file of files) {
      let real;
      try {
        real = await this.realpath(file);
      } catch {
        throw badInput(`File not found: ${file}.`);
      }
      // A symlink must not carry a denied file out under an innocent name.
      const verdict = checkPath(real);
      if (!verdict.ok) throw fail("BLOCKED_PATH", `${file} links to ${real}. ${sentence(verdict.reason)}`);
      const guarded = this._protected(real);
      if (guarded) throw fail("BLOCKED_PATH", real === file ? sentence(guarded) : `${file} links to ${real}. ${sentence(guarded)}`);
      if (seen.has(real)) continue;
      seen.add(real);

      let st;
      try {
        st = await this.stat(real);
      } catch {
        throw badInput(`File not found: ${file}.`);
      }
      if (!st.isFile()) throw badInput(`${file} is not a regular file.`);
      if (st.size > this.maxFileBytes) {
        throw badInput(`${file} is ${bytes(st.size)}; the limit is ${bytes(this.maxFileBytes)} per file.`);
      }
      // Bounds memory and scan time; far beyond what maxChunks can send anyway.
      total += st.size;
      if (total > this.maxFileBytes * this.maxChunks) {
        throw fail("TOO_LARGE", `The files add up to more than ${bytes(this.maxFileBytes * this.maxChunks)}.`);
      }

      let buf;
      try {
        buf = await this.readFile(real);
      } catch (err) {
        throw badInput(`Couldn't read ${file}: ${sentence(clip(err?.code || err?.message || "unknown error"))}`);
      }
      if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf ?? ""));
      if (buf.length > this.maxFileBytes) {
        throw badInput(`${file} is ${bytes(buf.length)}; the limit is ${bytes(this.maxFileBytes)} per file.`);
      }
      if (buf.subarray(0, SNIFF_BYTES).includes(0)) throw badInput(`${file} looks like a binary file; delegate only sends text.`);
      docs.push({ path: file, text: buf.toString("utf8") });
    }
    return docs;
  }

  _assertNoSecrets(input, docs) {
    const sources = [
      { where: "task", text: input.task },
      { where: "text", text: input.text },
      ...docs.map(d => ({ where: d.path, text: d.text })),
    ];
    let first = null;
    let count = 0;
    for (const { where, text } of sources) {
      const findings = scanText(text);
      if (!findings.length) continue;
      count += findings.length;
      if (!first) first = { where, ...findings[0] };
    }
    if (!first) return;
    const label = SECRET_LABELS[first.type] || first.type.replace(/_/g, " ");
    const more = count > 1 ? ` and ${count - 1} more possible secret${count > 2 ? "s" : ""}` : "";
    throw fail(
      "BLOCKED_SECRET",
      `Found a possible secret (${label}) at ${first.where}:${first.line} (${first.preview})${more}. Router sends nothing when the input contains a secret.`
    );
  }

  async _price(run) {
    try {
      const raw = await raceAbort(Promise.resolve().then(() => this.pricing()), run.signal, () => this._aborted(run));
      return normalizePrice(raw);
    } catch (err) {
      throw mapNetworkError(err);
    }
  }

  _plan(sources, budgetTokens, ctxTokens) {
    if (budgetTokens < (sources.length ? MIN_INPUT_TOKENS : 0)) {
      throw fail("TOO_LARGE", `The task is too long for the network's ${thousands(ctxTokens)}-token context.`, "Shorten the task, or do this task yourself.");
    }
    if (!sources.length) return [];
    // A cheap lower bound first: chars/4 never overestimates, so this can
    // only refuse input that the real count would refuse too.
    const quick = sources.reduce((n, s) => n + tokens(s.text.length), 0);
    const tooLarge = total =>
      fail(
        "TOO_LARGE",
        `The input is about ${thousands(total)} tokens; one delegation sends at most ${this.maxChunks} parts of about ${thousands(budgetTokens)} tokens.`
      );
    if (quick > budgetTokens * this.maxChunks) throw tooLarge(quick);
    const total = sources.reduce((n, s) => n + estimateTokens(s.text), 0);
    if (total > budgetTokens * this.maxChunks) throw tooLarge(total);
    const chunks = chunkInputs(sources, budgetTokens, this.maxChunks);
    if (chunks.length > this.maxChunks) throw tooLarge(total);
    return chunks;
  }

  /** Map answers → one answer. Small sets go back labelled per part, JSON
   *  merges deterministically, and only the rest is merged by a model. */
  async _combine(run, answers, input, formatLine, budget) {
    if (input.format === "json") {
      const merged = mergeJsonAnswers(answers);
      if (merged !== null) {
        run.combined = "json";
        return merged;
      }
    } else {
      const parts = partsAnswer(answers);
      if (estimateTokens(parts) <= PASSTHROUGH_TOKENS) {
        run.combined = "parts";
        return parts;
      }
    }
    run.combined = "model";
    return this._reduce(run, answers, input.task, formatLine, budget);
  }

  async _reduce(run, answers, task, formatLine, budget) {
    let round = answers;
    while (round.length > 1) {
      const groups = packAnswers(round, budget);
      if (groups.length === round.length) {
        throw fail("TOO_LARGE", "The partial answers are too long to combine in one request.");
      }
      const next = [];
      for (const group of groups) {
        next.push(group.length === 1 ? group[0] : await this._ask(run, reducePrompt(task, formatLine, group)));
      }
      round = next;
    }
    return round[0];
  }

  /** One network call (the caller holds the queue) → the answer text. */
  async _ask(run, userContent) {
    if (run.calls >= this.maxCalls) {
      throw fail("TOO_LARGE", `Combining the parts needed more than ${this.maxCalls} network calls.`);
    }
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];
    return this._send(run, messages);
  }

  async _send(run, messages) {
    await this._checkLimits(); // the user may have hit the limit or paused while we waited
    if (run.signal.aborted) throw this._aborted(run);
    run.calls += 1;

    const job = new AbortController();
    const timer = setTimeout(() => job.abort(), this.jobTimeoutMs);
    const relay = () => job.abort();
    run.signal.addEventListener("abort", relay, { once: true });
    const timeout = () => (run.signal.aborted ? this._aborted(run) : this._jobTimeout());
    let res;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const call = Promise.resolve().then(() => this.chat({ messages, maxTokens: OUTPUT_TOKENS, signal: job.signal }));
          res = await raceAbort(call, job.signal, timeout);
          break;
        } catch (err) {
          if (job.signal.aborted) throw timeout();
          // Another Mac on this wallet holds the one consume slot: it frees
          // within seconds, so wait for it inside this job's time.
          const wait = this.walletBusyBackoffMs[attempt];
          if (Number(err?.status) === 409 && WALLET_BUSY_RE.test(String(err?.message || "")) && wait !== undefined) {
            this._emit({ type: "delegate:wallet-busy", attempt: attempt + 1 });
            await raceAbort(new Promise(r => setTimeout(r, wait)), job.signal, timeout);
            continue;
          }
          throw mapNetworkError(err);
        }
      }
    } finally {
      clearTimeout(timer);
      run.signal.removeEventListener("abort", relay);
    }

    // Charge before judging the answer: an empty answer was still paid for.
    const content = typeof res?.content === "string" ? res.content.trim() : "";
    run.inTok += tokenCount(res?.usage?.prompt_tokens) ?? estimateMessageTokens(messages);
    run.outTok += tokenCount(res?.usage?.completion_tokens) ?? tokens(content.length);
    if (res?.servedModel) run.model = String(res.servedModel);
    if (!content) throw fail("NETWORK_ERROR", "The network returned an empty answer.");
    return content;
  }

  /** Why run.signal fired: the caller cancelled, or the run ran out of time. */
  _aborted(run) {
    if (run.cancelled) return fail("CANCELLED", "The agent cancelled the delegation.");
    return fail("TIMEOUT", `The delegation took longer than ${duration(run.timeoutMs)}.`);
  }

  _jobTimeout() {
    return fail("TIMEOUT", `A network job took longer than ${duration(this.jobTimeoutMs)}.`);
  }

  /** One ledger entry per run, ok or not; failed runs carry what they spent. */
  _finish(run) {
    const { usd, kai } = costOf(run);
    const entry = {
      kind: "delegate",
      harness: run.harness,
      task: run.task,
      kai: kai == null ? null : kai === 0 ? 0 : -kai,
      usd,
      inTok: run.inTok,
      outTok: run.outTok,
      chunks: run.chunks,
      model: run.model || (run.calls ? FALLBACK_MODEL : null),
      ok: !run.error,
    };
    if (run.error) entry.error = run.error.code;
    const reportLedgerError = err => this._emit({ type: "delegate:ledger-error", message: String(err?.message || err) });
    try {
      const stored = this.ledger.record(entry);
      if (stored && typeof stored.then === "function") stored.then(null, reportLedgerError);
    } catch (err) {
      reportLedgerError(err);
    }
    this._open.delete(run);
    this._emit({
      type: "delegate:done",
      harness: run.harness,
      ok: !run.error,
      code: run.error ? run.error.code : null,
      chunks: run.chunks,
      calls: run.calls,
      inTok: run.inTok,
      outTok: run.outTok,
      kai,
      ms: this.now() - run.startedAt,
    });
  }

  _emit(event) {
    try {
      this.onEvent(event);
    } catch {
      // a logging hook must never break a delegation
    }
  }
}

module.exports = {
  DelegateEngine,
  DelegateError,
  CODES,
  SYSTEM_PROMPT,
  OUTPUT_TOKENS,
  TEMPLATE_TOKENS,
  PASSTHROUGH_TOKENS,
  FORMAT_LINES,
  estimateMessageTokens,
  estimateTokens,
  chunkInputs,
  fileLabels,
  mapPrompt,
  reducePrompt,
  mergeJsonAnswers,
};
