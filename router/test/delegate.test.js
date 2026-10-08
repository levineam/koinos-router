"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DelegateEngine,
  DelegateError,
  CODES,
  SYSTEM_PROMPT,
  TEMPLATE_TOKENS,
  PASSTHROUGH_TOKENS,
  estimateMessageTokens,
  estimateTokens,
  chunkInputs,
  fileLabels,
  mapPrompt,
  reducePrompt,
} = require("../lib/delegate");

/*
 * The delegate engine is tested against fakes only: an in-memory ledger, a
 * scripted chat() and fixed pricing. Files live in temp dirs. Nothing here
 * talks to a scheduler or reads the user's home directory.
 */

const DO_IT_YOURSELF = "Do this task yourself instead.";
const OUTPUT_TOKENS = 512;
const PRICE = { ctxTokens: 4096, inMicroPerM: 200_000, outMicroPerM: 600_000, kaiRefUsd: 0.01 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-delegate-"));
}

function writeFile(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function fakeLedger(baseSpent = 0) {
  const entries = [];
  return {
    entries,
    record(entry) {
      const stored = { id: String(entries.length + 1), at: Date.now(), ...entry };
      entries.push(stored);
      return stored;
    },
    spentToday() {
      return entries.filter(e => e.kind === "delegate" && e.kai != null).reduce((n, e) => n + Math.abs(e.kai), baseSpent);
    },
  };
}

/** A chat() that records every call and fails the test if it is ever
 *  entered while another call is still running. */
function fakeChat(reply = () => "ok", { delayMs = 0, usage = { prompt_tokens: 100, completion_tokens: 20 }, servedModel = "koinos-smart" } = {}) {
  let inFlight = 0;
  const chat = async ({ messages, maxTokens, signal }) => {
    inFlight += 1;
    if (inFlight > 1) chat.reentered += 1;
    const call = { messages, maxTokens, signal, user: messages[messages.length - 1].content };
    chat.calls.push(call);
    try {
      if (delayMs) await sleep(delayMs);
      const content = await reply(call, chat.calls.length);
      return { content, usage, servedModel };
    } finally {
      inFlight -= 1;
    }
  };
  chat.calls = [];
  chat.reentered = 0;
  return chat;
}

function makeEngine({ chat = fakeChat(), price = PRICE, ledger = fakeLedger(), limits, ...rest } = {}) {
  const pricing = async () => {
    pricing.count += 1;
    return price;
  };
  pricing.count = 0;
  const lim = limits || { enabled: true, dailyLimitKai: null };
  const engine = new DelegateEngine({
    chat,
    pricing,
    ledger,
    limits: typeof lim === "function" ? lim : () => lim,
    ...rest,
  });
  return { engine, chat, ledger, pricing };
}

async function rejectsWith(promise, code, pattern) {
  let caught;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected ${code}, but the run succeeded`);
  assert.ok(caught instanceof DelegateError, `expected a DelegateError, got ${caught?.stack || caught}`);
  assert.strictEqual(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}

/** Input budget per map call, in (conservative) tokens, the engine's formula. */
function budgetTokens(ctxTokens, task, formatLine = "") {
  const fixed = ctxTokens - OUTPUT_TOKENS - estimateTokens(SYSTEM_PROMPT) - TEMPLATE_TOKENS;
  return fixed - estimateTokens(mapPrompt(task, formatLine, "", 99, 99)) - estimateTokens("\n\nInput:\n");
}

/** Room for partial answers in one reduce call. */
function reduceBudget(ctxTokens, task, formatLine = "") {
  return ctxTokens - OUTPUT_TOKENS - estimateTokens(SYSTEM_PROMPT) - TEMPLATE_TOKENS - estimateTokens(reducePrompt(task, formatLine, []));
}

/** About n tokens of ordinary words. */
const words = n => "word ".repeat(Math.max(0, Math.floor(n / 1.05))).trimEnd();

/** n lines that each fill 60% of a chunk: exactly one line per chunk. */
function oneLinePerChunk(n, ctxTokens, task) {
  const target = Math.floor(budgetTokens(ctxTokens, task) * 0.6);
  return Array.from({ length: n }, (_, i) => `line-${i + 1}: ${words(target - 12)}`).join("\n");
}

function assertFitsContext(chat, ctxTokens) {
  for (const call of chat.calls) {
    // The gateway's gate, and the real-tokenizer-safe estimate.
    const gate = estimateMessageTokens(call.messages);
    assert.ok(gate <= ctxTokens - OUTPUT_TOKENS, `prompt is ~${gate} tokens by chars/4, over ${ctxTokens - OUTPUT_TOKENS}`);
    const est = call.messages.reduce((n, m) => n + estimateTokens(m.content), TEMPLATE_TOKENS);
    assert.ok(est <= ctxTokens - OUTPUT_TOKENS, `prompt is ~${est} real tokens, over ${ctxTokens - OUTPUT_TOKENS}`);
    assert.strictEqual(call.maxTokens, OUTPUT_TOKENS);
  }
}

// Fake secrets are assembled at runtime so no token-shaped literal sits in the repo.
const FAKE_AWS_KEY = "AK" + "IA" + "Q7XK2M9WLR4TZ8PV";

// ---------------------------------------------------------------- basics

test("exports the contract's error codes", () => {
  assert.deepStrictEqual(CODES, [
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
  ]);
  const err = new DelegateError("TIMEOUT", "slow", "hint");
  assert.ok(err instanceof Error);
  assert.deepStrictEqual([err.code, err.message, err.hint], ["TIMEOUT", "slow", "hint"]);
});

test("token estimate matches the gateway's for plain-text messages", () => {
  // Required here, not at the top: delegate.js deliberately copies the logic instead.
  const gateway = require("../../core/lib/gateway");
  const samples = [
    [],
    [{ role: "user", content: "" }],
    [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "x".repeat(4097) }],
    [{ role: "user", content: [{ type: "text", text: "abc" }, { type: "text", text: "defgh" }] }],
  ];
  for (const messages of samples) assert.strictEqual(estimateMessageTokens(messages), gateway.estimateMessageTokens(messages));
  assert.strictEqual(estimateMessageTokens([{ role: "user", content: "12345" }]), Math.ceil(5 / 4) + 4);
});

test("one small input is one call with the system prompt, task and input", async () => {
  const dir = tmpDir();
  const file = writeFile(dir, "proj/logs/test.log", "PASS a\nFAIL b: expected 1, got 2\n");
  const { engine, chat, ledger } = makeEngine({ chat: fakeChat(() => "1 failure: b (expected 1, got 2)") });

  const res = await engine.run({ task: "Summarize the failures.", files: [file], text: "extra note", harness: "codex" });

  assert.strictEqual(res.text, "1 failure: b (expected 1, got 2)");
  assert.strictEqual(chat.calls.length, 1);
  const [call] = chat.calls;
  assert.deepStrictEqual(call.messages.map(m => m.role), ["system", "user"]);
  assert.strictEqual(call.messages[0].content, SYSTEM_PROMPT);
  assert.match(call.user, /^Summarize the failures\./);
  assert.match(call.user, /### Inline text\nextra note/);
  assert.match(call.user, /### File: test\.log\nPASS a\nFAIL b: expected 1, got 2\n/);
  assert.ok(!call.user.includes(dir), "the full local path is not sent to the network");
  assert.doesNotMatch(call.user, /This is part/);
  assert.ok(call.signal instanceof AbortSignal);
  assertFitsContext(chat, PRICE.ctxTokens);

  // usd = (100 * 200000 + 20 * 600000) / 1e12; kai = usd / 0.01
  assert.deepStrictEqual(Object.keys(res.meta).sort(), ["calls", "chunks", "combined", "inTok", "kai", "model", "outTok", "usd"]);
  assert.strictEqual(res.meta.combined, null);
  assert.strictEqual(res.meta.chunks, 1);
  assert.strictEqual(res.meta.calls, 1);
  assert.strictEqual(res.meta.model, "koinos-smart");
  assert.strictEqual(res.meta.inTok, 100);
  assert.strictEqual(res.meta.outTok, 20);
  close(res.meta.usd, 3.2e-5);
  close(res.meta.kai, 0.0032);

  assert.strictEqual(ledger.entries.length, 1);
  const entry = ledger.entries[0];
  assert.strictEqual(entry.kind, "delegate");
  assert.strictEqual(entry.harness, "codex");
  assert.strictEqual(entry.task, "Summarize the failures.");
  close(entry.kai, -0.0032);
  close(entry.usd, 3.2e-5);
  assert.strictEqual(entry.inTok, 100);
  assert.strictEqual(entry.outTok, 20);
  assert.strictEqual(entry.chunks, 1);
  assert.strictEqual(entry.model, "koinos-smart");
  assert.strictEqual(entry.ok, true);
  assert.ok(!("error" in entry));
});

test("a task with no input is sent as-is", async () => {
  const { engine, chat } = makeEngine({ chat: fakeChat(() => "feat: add router") });
  const res = await engine.run({ task: "Write a one-line commit message for adding the router." });
  assert.strictEqual(chat.calls[0].user, "Write a one-line commit message for adding the router.");
  assert.strictEqual(res.meta.chunks, 1);
  assert.strictEqual(res.text, "feat: add router");
});

test("several small inputs share one chunk, and a file passed twice is read once", async () => {
  const dir = tmpDir();
  const a = writeFile(dir, "a.log", "alpha\n");
  const b = writeFile(dir, "b.log", "beta");
  const { engine, chat } = makeEngine();
  await engine.run({ task: "List the words.", files: [a, b, a], text: "gamma" });
  assert.strictEqual(chat.calls.length, 1);
  const user = chat.calls[0].user;
  assert.match(user, /### Inline text\ngamma\n\n### File: a\.log\nalpha\n\n### File: b\.log\nbeta$/);
  assert.strictEqual(user.split("### File: a.log").length, 2);
});

test("format json and markdown add the instruction; json answers lose a code fence", async () => {
  const json = makeEngine({ chat: fakeChat(() => '```json\n{"failures": 1}\n```') });
  const res = await json.engine.run({ task: "Count failures.", text: "FAIL a", format: "json" });
  assert.match(json.chat.calls[0].user, /Respond with valid JSON only\./);
  assert.strictEqual(res.text, '{"failures": 1}');

  const md = makeEngine({ chat: fakeChat(() => "- a\n- b") });
  const res2 = await md.engine.run({ task: "List items.", text: "a b", format: "markdown" });
  assert.match(md.chat.calls[0].user, /Respond in Markdown only\./);
  assert.strictEqual(res2.text, "- a\n- b");

  const plain = makeEngine();
  await plain.engine.run({ task: "Do it.", text: "x" });
  assert.doesNotMatch(plain.chat.calls[0].user, /Respond (with|in)/);
});

test("kai is null when the network gives no KAI reference price; usd is still computed", async () => {
  const { engine, ledger } = makeEngine({ price: { ...PRICE, kaiRefUsd: null } });
  const res = await engine.run({ task: "t", text: "x" });
  assert.strictEqual(res.meta.kai, null);
  close(res.meta.usd, 3.2e-5);
  assert.strictEqual(ledger.entries[0].kai, null);
  close(ledger.entries[0].usd, 3.2e-5);
});

test("missing usage falls back to the chars/4 estimate", async () => {
  const chat = fakeChat(() => "twelve chars", { usage: null });
  const { engine } = makeEngine({ chat });
  const res = await engine.run({ task: "t", text: "some input" });
  assert.strictEqual(res.meta.inTok, estimateMessageTokens(chat.calls[0].messages));
  assert.strictEqual(res.meta.outTok, Math.ceil("twelve chars".length / 4));
});

test("an unknown harness is recorded as other", async () => {
  const { engine, ledger } = makeEngine();
  await engine.run({ task: "t", text: "x", harness: "cursor" });
  await engine.run({ task: "t", text: "x", harness: "claude" });
  assert.deepStrictEqual(ledger.entries.map(e => e.harness), ["other", "claude"]);
});

// ---------------------------------------------------------------- token budget

// Deterministic samples. The real counts beside them were measured with the
// network's tokenizer (Qwen 2.5, llama.cpp b10423 llama-tokenize) on exactly
// these strings; chars/4 is far below every one of them except prose.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function ciLog(lines, seed = 1) {
  const r = rng(seed);
  const n = k => Math.floor(r() * k);
  const names = ["parser", "lexer", "auth", "router", "ledger", "delegate"];
  let t = Date.UTC(2026, 9, 7, 13, 0, 0);
  const out = [];
  for (let i = 0; i < lines; i++) {
    t += n(900);
    const ts = new Date(t).toISOString();
    const name = names[n(names.length)];
    switch (i % 4) {
      case 0: out.push(`${ts} ✔ ${name}.test.js > handles case ${n(400)} (${(r() * 90).toFixed(3)}ms)`); break;
      case 1: out.push(`${ts} ✖ ${name}.test.js > rejects input #${n(400)} (${(r() * 900).toFixed(2)}ms)`, `    AssertionError: expected ${n(1e6)} to equal ${n(1e6)}`, `      at Object.<anonymous> (/home/runner/work/app/app/test/${name}.test.js:${n(500)}:${n(40)})`); break;
      case 2: out.push(`${ts} [INFO] GET /api/v1/${name}/${n(99999)} 200 ${n(5000)}b ${(r() * 300).toFixed(1)}ms 10.0.${n(255)}.${n(255)}`); break;
      default: out.push(`${ts} Downloaded ${(r() * 900).toFixed(1)} MB in ${(r() * 60).toFixed(2)} s`);
    }
  }
  return out.join("\n") + "\n";
}
function csv(rows, seed = 2) {
  const r = rng(seed);
  const out = ["id,date,amount,qty,ratio,sku"];
  for (let i = 0; i < rows; i++) out.push(`${1000 + i},2026-0${1 + Math.floor(r() * 9)}-${10 + Math.floor(r() * 18)},${(r() * 9999).toFixed(2)},${Math.floor(r() * 500)},${r().toFixed(6)},SKU-${Math.floor(r() * 1e6)}`);
  return out.join("\n") + "\n";
}
function base64Lines(lines, seed = 3) {
  const r = rng(seed);
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = [];
  for (let i = 0; i < lines; i++) out.push(Array.from({ length: 64 }, () => A[Math.floor(r() * 64)]).join(""));
  return out.join("\n") + "\n";
}
const CJK = "在这个项目中，我们需要处理大量的日志文件，并把错误按照原因进行分类。\nこのプロジェクトでは、大量のログファイルを処理し、エラーを原因ごとに分類する必要があります。\n이 프로젝트에서는 많은 로그 파일을 처리하고 오류를 원인별로 분류해야 합니다.\n".repeat(6);
const PROSE = "Router keeps the person's Mac responsive: it only shares compute while they are away, and it gives the memory back the moment they return. Delegations are small, bounded text chores such as summarizing a test log or drafting a commit message. Every request is checked for credentials before anything leaves the machine, and the daily limit caps what the agent can spend.\n".repeat(8);
const CODE = "async function retry(fn, { attempts = 3, delayMs = 250 } = {}) {\n  let lastError;\n  for (let i = 0; i < attempts; i++) {\n    try {\n      return await fn(i);\n    } catch (err) {\n      lastError = err;\n      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** i));\n    }\n  }\n  throw lastError;\n}\n".repeat(6);
const EMOJI = "- ✅ build passed in 42 s\n- ❌ lint failed: 3 errors\n- ⚠️ résumé façade naïve\n- 🚀 deployed v1.2.3\n".repeat(10);
const REAL_TOKENS = [
  ["CI log", () => ciLog(60), 3665],
  ["CSV", () => csv(80), 3653],
  ["base64", () => base64Lines(40), 1933],
  ["CJK", () => CJK, 408],
  ["prose", () => PROSE, 584],
  ["code", () => CODE, 564],
  ["emoji and accents", () => EMOJI, 460],
];

test("the token estimate is never below the network tokenizer's real count", () => {
  for (const [name, make, real] of REAL_TOKENS) {
    const text = make();
    const est = estimateTokens(text);
    assert.ok(est >= real, `${name}: estimated ${est}, real ${real}`);
    assert.ok(est <= real * 1.6, `${name}: estimated ${est} is too pessimistic for ${real}`);
    assert.ok(est >= Math.ceil(text.length / 4), `${name}: below the gateway's chars/4`);
  }
  // Additive over line-aligned pieces, which chunk packing relies on.
  const log = ciLog(30);
  const lines = log.match(/[^\n]*\n/g);
  assert.ok(lines.reduce((n, l) => n + estimateTokens(l), 0) >= estimateTokens(log));
});

test("a 40 KB digit-heavy log is cut into chunks that really fit a 4,096-token worker", async () => {
  // ~0.58 real tokens per char (measured above). The chars/4 budget used to
  // pack ~13.9k chars per chunk: ~8k real tokens against a 4,096 context.
  const realPerChar = 3665 / ciLog(60).length;
  const log = ciLog(380);
  assert.ok(log.length > 39_000, `${log.length} chars`);
  const task = "Summarize this CI log: list each failing test with its error, and give the pass and fail counts.";
  const chat = fakeChat(call => `part ${/This is part (\d+)/.exec(call.user)?.[1]}`);
  const { engine } = makeEngine({ chat, price: { ...PRICE, ctxTokens: 4096 } });
  const res = await engine.run({ task, text: log });
  assert.ok(res.meta.chunks >= 7 && res.meta.chunks <= 8, `${res.meta.chunks} chunks`);
  for (const call of chat.calls) {
    const real = Math.ceil(call.user.length * realPerChar) + Math.ceil(SYSTEM_PROMPT.length / 3) + 16;
    assert.ok(real + OUTPUT_TOKENS <= 4096, `a prompt of ~${real} real tokens leaves no room for the answer`);
  }
  assertFitsContext(chat, 4096);
});

// ---------------------------------------------------------------- chunking

test("chunkInputs breaks only at line ends and reassembles exactly", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${String(i).padStart(2, "0")}: ${"x".repeat(20)}`);
  const text = lines.join("\n") + "\n";
  const chunks = chunkInputs([{ label: "File: a.log", text }], 200, Infinity, s => s.length);
  assert.ok(chunks.length > 1);
  let rebuilt = "";
  chunks.forEach((chunk, i) => {
    assert.ok(chunk.length <= 200, `chunk ${i} is ${chunk.length} chars`);
    const [header, ...body] = chunk.split("\n");
    assert.strictEqual(header, i === 0 ? "### File: a.log" : "### File: a.log (continued)");
    const bodyText = body.join("\n");
    for (const line of bodyText.split("\n").filter(Boolean)) assert.ok(lines.includes(line), `split line: ${line}`);
    rebuilt += bodyText;
  });
  assert.strictEqual(rebuilt, text);
});

test("chunkInputs hard-splits a line longer than a chunk", () => {
  const line = Array.from({ length: 500 }, (_, i) => String.fromCharCode(65 + (i % 26))).join("");
  const chunks = chunkInputs([{ label: "Inline text", text: line }], 120, Infinity, s => s.length);
  assert.ok(chunks.length >= 5);
  for (const chunk of chunks) assert.ok(chunk.length <= 120);
  const rebuilt = chunks.map(c => c.slice(c.indexOf("\n") + 1)).join("");
  assert.strictEqual(rebuilt, line);
});

test("chunkInputs never splits a surrogate pair", () => {
  const text = "😀".repeat(100);
  const chunks = chunkInputs([{ label: "Inline text", text }], 61, Infinity, s => s.length);
  const rebuilt = chunks.map(c => c.slice(c.indexOf("\n") + 1)).join("");
  assert.strictEqual(rebuilt, text);
  for (const c of chunks) assert.doesNotMatch(c, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});

test("chunkInputs stops once it passes the limit", () => {
  const text = "y".repeat(50).concat("\n").repeat(1000);
  const chunks = chunkInputs([{ label: "Inline text", text }], 100, 3, s => s.length);
  assert.strictEqual(chunks.length, 4);
});

test("a 3-chunk input runs map on each part; short partial answers go back per part, with no reduce call", async () => {
  const ctxTokens = 1200;
  const task = "List every line label you see.";
  const text = oneLinePerChunk(3, ctxTokens, task);
  const chat = fakeChat(call => {
    const part = /This is part (\d+) of (\d+) of the input\./.exec(call.user);
    return `labels from part ${part[1]}: line-${part[1]}`;
  });
  const { engine, ledger } = makeEngine({ chat, price: { ...PRICE, ctxTokens } });

  const res = await engine.run({ task, text });

  assert.strictEqual(chat.calls.length, 3);
  chat.calls.forEach((call, i) => {
    assert.ok(call.user.startsWith(task), "every map call carries the task");
    assert.match(call.user, new RegExp(`This is part ${i + 1} of 3 of the input\\.`));
    assert.ok(call.user.includes(`line-${i + 1}:`), `part ${i + 1} carries line ${i + 1}`);
    for (let j = 1; j <= 3; j++) if (j !== i + 1) assert.ok(!call.user.includes(`line-${j}:`));
  });
  // A small model asked to add up parts gets the totals wrong; the agent can add.
  assert.strictEqual(
    res.text,
    "The input was answered in 3 separate parts; combine them (counts are per part).\n\n" +
      "Part 1 of 3:\nlabels from part 1: line-1\n\nPart 2 of 3:\nlabels from part 2: line-2\n\nPart 3 of 3:\nlabels from part 3: line-3"
  );
  assert.strictEqual(res.meta.combined, "parts");
  assert.strictEqual(res.meta.chunks, 3);
  assert.strictEqual(res.meta.calls, 3);
  assert.strictEqual(res.meta.inTok, 300);
  assert.strictEqual(res.meta.outTok, 60);
  assertFitsContext(chat, ctxTokens);
  assert.strictEqual(chat.reentered, 0);
  assert.strictEqual(ledger.entries.length, 1);
  assert.strictEqual(ledger.entries[0].chunks, 3);
});

test("long partial answers are merged by one reduce call that is told to add counts across parts", async () => {
  const ctxTokens = 1200;
  const task = "Count the failures.";
  const long = Math.ceil(PASSTHROUGH_TOKENS / 2);
  const chat = fakeChat(call => {
    const part = /This is part (\d+) of (\d+) of the input\./.exec(call.user);
    if (part) return `part ${part[1]}: ${words(long)}`;
    return "FINAL";
  });
  const { engine } = makeEngine({ chat, price: { ...PRICE, ctxTokens: 4096 } });
  const res = await engine.run({ task, text: oneLinePerChunk(3, 4096, task) });
  const reduce = chat.calls[chat.calls.length - 1];
  assert.ok(reduce.user.startsWith(`Task: ${task}`));
  assert.match(reduce.user, /non-overlapping parts/);
  assert.match(reduce.user, /Add up counts and totals across all parts/);
  for (let i = 1; i <= 3; i++) assert.ok(reduce.user.includes(`Partial answer ${i}:\npart ${i}: word`));
  assert.strictEqual(res.text, "FINAL");
  assert.strictEqual(res.meta.combined, "model");
  assertFitsContext(chat, 4096);
});

test("json answers from several parts merge without a model: arrays join, counts add", async () => {
  const ctxTokens = 1200;
  const task = "Count passes and failures and list the failing tests.";
  const chat = fakeChat(call => {
    const part = Number(/This is part (\d+) of/.exec(call.user)[1]);
    return "```json\n" + JSON.stringify({ pass: part * 10, fail: part, failures: [`t${part}`] }) + "\n```";
  });
  const { engine } = makeEngine({ chat, price: { ...PRICE, ctxTokens } });
  const res = await engine.run({ task, text: oneLinePerChunk(3, ctxTokens, task), format: "json" });
  assert.strictEqual(chat.calls.length, 3, "no reduce call");
  assert.deepStrictEqual(JSON.parse(res.text), { pass: 60, fail: 6, failures: ["t1", "t2", "t3"] });
  assert.strictEqual(res.meta.combined, "json");
});

test("reduce runs in rounds when the partial answers don't fit one prompt", async () => {
  const ctxTokens = 1200;
  const task = "Summarize.";
  const budget = reduceBudget(ctxTokens, task);
  let reduces = 0;
  const chat = fakeChat(call => {
    const part = /This is part (\d+) of/.exec(call.user);
    // Long partials: two fit in one reduce prompt, three don't.
    if (part) return `P${part[1]}: ${words(Math.floor(budget * 0.4))}`;
    reduces += 1;
    return `R${reduces}`;
  });
  const { engine } = makeEngine({ chat, price: { ...PRICE, ctxTokens } });

  const res = await engine.run({ task, text: oneLinePerChunk(8, ctxTokens, task) });

  // 8 maps → 4 reduces of two partials each → 1 reduce of the four short results.
  assert.strictEqual(res.meta.chunks, 8);
  assert.strictEqual(res.meta.calls, 13);
  assert.strictEqual(res.text, "R5");
  const last = chat.calls[12].user;
  for (const r of ["R1", "R2", "R3", "R4"]) assert.match(last, new RegExp(`Partial answer \\d+:\\n${r}$`, "m"));
  assertFitsContext(chat, ctxTokens);
});

test("more chunks than maxChunks is TOO_LARGE and sends nothing", async () => {
  const ctxTokens = 1200;
  const task = "Summarize.";
  const { engine, chat, ledger } = makeEngine({ price: { ...PRICE, ctxTokens } });
  const err = await rejectsWith(engine.run({ task, text: oneLinePerChunk(9, ctxTokens, task) }), "TOO_LARGE", /at most 8 parts/);
  assert.match(err.hint, /Narrow the input/);
  assert.strictEqual(chat.calls.length, 0);
  assert.deepStrictEqual(
    [ledger.entries.length, ledger.entries[0].ok, ledger.entries[0].error, ledger.entries[0].kai],
    [1, false, "TOO_LARGE", null]
  );

  // Exactly maxChunks is fine.
  const ok = makeEngine({ price: { ...PRICE, ctxTokens }, maxChunks: 3 });
  const res = await ok.engine.run({ task, text: oneLinePerChunk(3, ctxTokens, task) });
  assert.strictEqual(res.meta.chunks, 3);
  await rejectsWith(ok.engine.run({ task, text: oneLinePerChunk(4, ctxTokens, task) }), "TOO_LARGE", /at most 3 parts/);
});

test("a huge file is TOO_LARGE before any chunking or network call", async () => {
  const dir = tmpDir();
  const file = writeFile(dir, "big.log", "log line\n".repeat(200_000));
  const { engine, chat } = makeEngine();
  await rejectsWith(engine.run({ task: "Summarize.", files: [file] }), "TOO_LARGE", /about 450,000 tokens/);
  assert.strictEqual(chat.calls.length, 0);
});

test("partial answers that can't be combined fail TOO_LARGE and the ledger keeps what was spent", async () => {
  const ctxTokens = 1200;
  const task = "Summarize.";
  const chat = fakeChat(() => words(reduceBudget(ctxTokens, task) + 10));
  const { engine, ledger } = makeEngine({ chat, price: { ...PRICE, ctxTokens } });
  await rejectsWith(engine.run({ task, text: oneLinePerChunk(2, ctxTokens, task) }), "TOO_LARGE", /too long to combine/);
  assert.strictEqual(chat.calls.length, 2);
  const entry = ledger.entries[0];
  assert.strictEqual(entry.ok, false);
  assert.strictEqual(entry.error, "TOO_LARGE");
  close(entry.kai, -0.0064); // two calls' worth
  assert.strictEqual(entry.inTok, 200);
});

test("a task too long for the network's context is TOO_LARGE", async () => {
  const { engine, chat } = makeEngine({ price: { ...PRICE, ctxTokens: 1024 } });
  await rejectsWith(engine.run({ task: "t".repeat(3000), text: "input" }), "TOO_LARGE", /1,024-token context/);
  assert.strictEqual(chat.calls.length, 0);
});

// ---------------------------------------------------------------- queue

test("concurrent runs share one FIFO queue, a run keeps it to the end, and nothing calls the network in parallel", async () => {
  const ctxTokens = 1200;
  const task = "Summarize.";
  const chat = fakeChat(call => (call.user.startsWith("Other") ? "other" : "part"), { delayMs: 15 });
  const { engine } = makeEngine({ chat, price: { ...PRICE, ctxTokens } });

  const a = engine.run({ task, text: oneLinePerChunk(3, ctxTokens, task) });
  const b = engine.run({ task: "Other task.", text: "small" });
  const [ra, rb] = await Promise.all([a, b]);

  assert.strictEqual(chat.reentered, 0, "chat() was entered while another call was in flight");
  assert.match(ra.text, /^The input was answered in 3 separate parts/);
  assert.strictEqual(rb.text, "other");
  assert.strictEqual(chat.calls.length, 4);
  // B queued while A was running; it waits for all of A rather than cutting in.
  const order = chat.calls.map(c => (c.user.startsWith("Other") ? "B" : `A${/part (\d)/.exec(c.user)[1]}`));
  assert.deepStrictEqual(order, ["A1", "A2", "A3", "B"]);
  assert.strictEqual(engine.queue.size, 0);
});

test("two concurrent map-reduce runs that each fit the time budget alone don't both time out", async () => {
  // 1/20 scale of the reported case: 5 parts + reduce at 20 ms a call is
  // ~120 ms alone; interleaved call by call, both runs needed ~240 ms and
  // both failed at 180 ms after paying for their maps.
  const ctxTokens = 4096;
  const task = "Summarize.";
  const long = Math.ceil(PASSTHROUGH_TOKENS / 3);
  const chat = fakeChat(call => (/This is part/.test(call.user) ? words(long) : "combined"), { delayMs: 20 });
  const { engine, ledger } = makeEngine({ chat, totalTimeoutMs: 180, price: { ...PRICE, ctxTokens } });
  const a = engine.run({ task, text: oneLinePerChunk(5, ctxTokens, task) });
  const b = engine.run({ task, text: oneLinePerChunk(5, ctxTokens, task) });
  const [ra, rb] = await Promise.allSettled([a, b]);
  assert.strictEqual(ra.status, "fulfilled", String(ra.reason?.message));
  assert.strictEqual(ra.value.text, "combined");
  assert.strictEqual(rb.status, "rejected");
  assert.strictEqual(rb.reason.code, "TIMEOUT");
  assert.deepStrictEqual(ledger.entries.map(e => e.ok), [true, false]);
  const order = chat.calls.map(c => c.user.length);
  assert.ok(order.length >= 6, "the first run made all six of its calls back to back");
});

test("runs started together are served in arrival order", async () => {
  const chat = fakeChat(call => call.user, { delayMs: 2 });
  const { engine } = makeEngine({ chat });
  const results = await Promise.all(["first", "second", "third", "fourth"].map(task => engine.run({ task })));
  assert.deepStrictEqual(chat.calls.map(c => c.user), ["first", "second", "third", "fourth"]);
  assert.deepStrictEqual(results.map(r => r.text), ["first", "second", "third", "fourth"]);
  assert.strictEqual(chat.reentered, 0);
});

test("a job that never answers times out and frees the queue", async () => {
  let n = 0;
  const signals = [];
  const chat = fakeChat(call => {
    n += 1;
    signals.push(call.signal);
    return n === 1 ? new Promise(() => {}) : "second run ok"; // first call ignores its signal and hangs
  });
  const { engine, ledger } = makeEngine({ chat, jobTimeoutMs: 40 });

  const err = await rejectsWith(engine.run({ task: "t", text: "x" }), "TIMEOUT", /A network job took longer than 40 ms/);
  assert.ok(err.hint.endsWith(DO_IT_YOURSELF));
  assert.strictEqual(signals[0].aborted, true, "the hung call's signal was aborted");
  const res = await engine.run({ task: "t", text: "x" });
  assert.strictEqual(res.text, "second run ok");
  assert.deepStrictEqual(ledger.entries.map(e => [e.ok, e.error]), [[false, "TIMEOUT"], [true, undefined]]);
});

test("a run that times out while queued leaves the line without calling the network", async () => {
  let n = 0;
  const chat = fakeChat(({ signal }) => {
    n += 1;
    if (n > 1) return "later ok";
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  });
  const { engine } = makeEngine({ chat, jobTimeoutMs: 300, totalTimeoutMs: 5000 });

  const a = engine.run({ task: "A", text: "x" });
  engine.totalTimeoutMs = 50; // each run keeps the deadline it started with
  const b = engine.run({ task: "B", text: "y" });

  await rejectsWith(b, "TIMEOUT", /The delegation took longer than 50 ms/);
  assert.strictEqual(chat.calls.length, 1, "B gave up in the queue while A was still running");
  assert.strictEqual(engine.queue.size, 1);
  await rejectsWith(a, "TIMEOUT", /A network job took longer than 300 ms/);
  assert.deepStrictEqual(chat.calls.map(c => c.user), ["A\n\nInput:\n### Inline text\nx"], "B never reached the network");
  assert.strictEqual(engine.queue.size, 0);

  const res = await engine.run({ task: "C", text: "z" });
  assert.strictEqual(res.text, "later ok");
});

test("the whole run is bounded across its jobs, and finished parts are charged", async () => {
  // The first part answers at once; later parts take 40 ms each, so six parts
  // can't finish inside a 100 ms run even though no single job times out.
  const chat = fakeChat(({ signal }, n) =>
    n === 1
      ? "part"
      : new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve("part"), 40);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        })
  );
  const task = "Summarize.";
  const { engine, ledger } = makeEngine({ chat, jobTimeoutMs: 5000, totalTimeoutMs: 100, price: { ...PRICE, ctxTokens: 1200 } });
  await rejectsWith(engine.run({ task, text: oneLinePerChunk(6, 1200, task) }), "TIMEOUT", /The delegation took longer than 100 ms/);
  assert.ok(chat.calls.length >= 2 && chat.calls.length < 6, `calls: ${chat.calls.length}`);
  assert.ok(ledger.entries[0].kai < 0, "the parts that finished are charged");
  assert.strictEqual(ledger.entries[0].error, "TIMEOUT");
});

// ---------------------------------------------------------------- cancellation

test("a cancelled delegation stops before its next network call and is recorded as CANCELLED", async () => {
  const controller = new AbortController();
  const chat = fakeChat((call, n) => {
    if (n === 1) controller.abort(); // the agent gives up while part 1 is in flight
    return words(400);
  }, { delayMs: 10 });
  const { engine, ledger } = makeEngine({ chat, price: { ...PRICE, ctxTokens: 1200 } });
  const err = await rejectsWith(engine.run({ task: "Summarize.", text: oneLinePerChunk(5, 1200, "Summarize."), signal: controller.signal }), "CANCELLED");
  assert.strictEqual(err.hint, "");
  assert.strictEqual(chat.calls.length, 1, "no map call after the cancel");
  assert.ok(chat.calls[0].signal.aborted, "the call in flight was aborted too");
  assert.deepStrictEqual([ledger.entries[0].ok, ledger.entries[0].error], [false, "CANCELLED"]);
  assert.strictEqual(engine.queue.size, 0);

  // Cancelled while still queued behind another run: never reaches the network.
  const slow = makeEngine({ chat: fakeChat(() => "a", { delayMs: 40 }) });
  const first = slow.engine.run({ task: "A", text: "x" });
  const c2 = new AbortController();
  const second = slow.engine.run({ task: "B", text: "y", signal: c2.signal });
  c2.abort();
  await rejectsWith(second, "CANCELLED");
  await first;
  assert.deepStrictEqual(slow.chat.calls.map(c => c.user[0]), ["A"]);

  // Already cancelled: nothing is read or sent.
  const done = makeEngine();
  await rejectsWith(done.engine.run({ task: "t", text: "x", signal: AbortSignal.abort() }), "CANCELLED");
  assert.strictEqual(done.chat.calls.length, 0);
});

// ---------------------------------------------------------------- errors from the network

const networkErrors = [
  [{ status: 402, message: "Insufficient KAI balance" }, "OUT_OF_KAI"],
  [{ status: 409, message: "A request is already in flight for this wallet" }, "NETWORK_BUSY"],
  [{ status: 503, message: "Service unavailable" }, "NETWORK_BUSY"],
  [{ status: 502, message: "No providers online for class auto" }, "NETWORK_BUSY"],
  [{ status: 500, message: "Scheduler at capacity" }, "NETWORK_BUSY"],
  [{ name: "AbortError", message: "This operation was aborted" }, "TIMEOUT"],
  [{ name: "TimeoutError", message: "The operation was aborted due to timeout" }, "TIMEOUT"],
  [{ status: 400, message: "Koinos Network is off (Local-Only mode)" }, "PAUSED"],
  [{ status: 400, message: "Prompt is too large" }, "NETWORK_ERROR"],
  [{ status: 500, message: "Internal error" }, "NETWORK_ERROR"],
  [{ message: "fetch failed" }, "NETWORK_ERROR"],
];

for (const [shape, code] of networkErrors) {
  test(`chat error ${JSON.stringify(shape)} → ${code}`, async () => {
    const chat = fakeChat(() => {
      throw Object.assign(new Error(shape.message), shape);
    });
    const { engine, ledger } = makeEngine({ chat, walletBusyBackoffMs: [1, 1] });
    const err = await rejectsWith(engine.run({ task: "t", text: "x" }), code);
    assert.ok(err.hint.endsWith(DO_IT_YOURSELF), `hint for ${code}: ${err.hint}`);
    // The wallet's one consume slot being taken is retried briefly first.
    assert.strictEqual(chat.calls.length, /in flight/.test(shape.message) ? 3 : 1);
    assert.deepStrictEqual([ledger.entries[0].ok, ledger.entries[0].error, ledger.entries[0].kai], [false, code, null]);
  });
}

test("another Mac holding the wallet's consume slot is waited out, not reported as no capacity", async () => {
  let n = 0;
  const chat = fakeChat(() => {
    n += 1;
    if (n <= 2) throw Object.assign(new Error("An earlier request for this wallet is still running"), { status: 409 });
    return "done";
  });
  const { engine, ledger } = makeEngine({ chat, walletBusyBackoffMs: [5, 5, 5] });
  const res = await engine.run({ task: "t", text: "x" });
  assert.strictEqual(res.text, "done");
  assert.strictEqual(chat.calls.length, 3);
  assert.strictEqual(res.meta.calls, 1, "one network job, however many tries it took");
  assert.strictEqual(ledger.entries[0].ok, true);

  // Any other 409 is still NETWORK_BUSY at once.
  const other = makeEngine({ chat: fakeChat(() => { throw Object.assign(new Error("Conflict"), { status: 409 }); }), walletBusyBackoffMs: [5] });
  await rejectsWith(other.engine.run({ task: "t", text: "x" }), "NETWORK_BUSY");
  assert.strictEqual(other.chat.calls.length, 1);
});

test("a network error message is kept, clipped, for the agent", async () => {
  const chat = fakeChat(() => {
    throw Object.assign(new Error("upstream said no " + "x".repeat(500)), { status: 500 });
  });
  const { engine } = makeEngine({ chat });
  const err = await rejectsWith(engine.run({ task: "t", text: "x" }), "NETWORK_ERROR", /\(HTTP 500\): upstream said no/);
  assert.ok(err.message.length < 300);
});

test("an empty answer is a NETWORK_ERROR but still charged", async () => {
  const { engine, ledger } = makeEngine({ chat: fakeChat(() => "   ") });
  await rejectsWith(engine.run({ task: "t", text: "x" }), "NETWORK_ERROR", /empty answer/);
  close(ledger.entries[0].kai, -0.0032);
});

test("a pricing failure is mapped like a chat failure", async () => {
  const ledger = fakeLedger();
  const chat = fakeChat();
  const engine = new DelegateEngine({
    chat,
    ledger,
    limits: () => ({ enabled: true, dailyLimitKai: null }),
    pricing: async () => {
      throw Object.assign(new Error("Service unavailable"), { status: 503 });
    },
  });
  await rejectsWith(engine.run({ task: "t", text: "x" }), "NETWORK_BUSY");
  assert.strictEqual(chat.calls.length, 0);
});

test("hints end with the fallback sentence for every code the agent can't fix", async () => {
  const cases = {
    PAUSED: makeEngine({ limits: { enabled: false, dailyLimitKai: null } }),
    DAILY_LIMIT: makeEngine({ ledger: fakeLedger(5), limits: { enabled: true, dailyLimitKai: 5 } }),
  };
  for (const [code, { engine }] of Object.entries(cases)) {
    const err = await rejectsWith(engine.run({ task: "t", text: "x" }), code);
    assert.ok(err.hint.endsWith(DO_IT_YOURSELF), `${code}: ${err.hint}`);
  }
});

// ---------------------------------------------------------------- limits

test("Use KoinosAI off is PAUSED before anything is read or priced", async () => {
  let reads = 0;
  const { engine, chat, pricing, ledger } = makeEngine({
    limits: { enabled: false, dailyLimitKai: null },
    readFile: async () => {
      reads += 1;
      return Buffer.from("x");
    },
  });
  await rejectsWith(engine.run({ task: "t", files: ["/Users/x/proj/logs/test.log"] }), "PAUSED", /turned off/);
  assert.deepStrictEqual([reads, pricing.count, chat.calls.length], [0, 0, 0]);
  assert.deepStrictEqual([ledger.entries[0].ok, ledger.entries[0].error, ledger.entries[0].kai], [false, "PAUSED", null]);
});

test("spent today at the daily limit is DAILY_LIMIT before any network call", async () => {
  const { engine, chat, pricing } = makeEngine({ ledger: fakeLedger(5), limits: { enabled: true, dailyLimitKai: 5 } });
  await rejectsWith(engine.run({ task: "t", text: "x" }), "DAILY_LIMIT", /\(5 KAI\)/);
  assert.deepStrictEqual([pricing.count, chat.calls.length], [0, 0]);

  const under = makeEngine({ ledger: fakeLedger(4.99), limits: { enabled: true, dailyLimitKai: 5 } });
  await under.engine.run({ task: "t", text: "x" });
});

// 100 prompt tokens at 1e8 micro-USD per million = $0.01 = 1 KAI per call.
const ONE_KAI_PER_CALL = { ctxTokens: 1200, inMicroPerM: 1e8, outMicroPerM: 0, kaiRefUsd: 0.01 };

test("the daily limit is checked before every call of a map-reduce run", async () => {
  const task = "Summarize.";
  const { engine, chat, ledger } = makeEngine({
    price: ONE_KAI_PER_CALL,
    limits: { enabled: true, dailyLimitKai: 2 },
  });
  await rejectsWith(engine.run({ task, text: oneLinePerChunk(3, ONE_KAI_PER_CALL.ctxTokens, task) }), "DAILY_LIMIT");
  assert.strictEqual(chat.calls.length, 2);
  const entry = ledger.entries[0];
  assert.deepStrictEqual([entry.ok, entry.error, entry.kai, entry.chunks], [false, "DAILY_LIMIT", -2, 3]);
});

test("spend of runs still in flight counts toward the daily limit", async () => {
  const chat = fakeChat(() => "ok", { delayMs: 10 });
  const { engine, ledger } = makeEngine({ chat, price: ONE_KAI_PER_CALL, limits: { enabled: true, dailyLimitKai: 1 } });
  const [a, b] = await Promise.allSettled([engine.run({ task: "A", text: "x" }), engine.run({ task: "B", text: "y" })]);
  assert.strictEqual(a.status, "fulfilled");
  assert.strictEqual(b.status, "rejected");
  assert.strictEqual(b.reason.code, "DAILY_LIMIT");
  assert.strictEqual(chat.calls.length, 1);
  assert.deepStrictEqual(ledger.entries.map(e => e.kai).sort(), [-1, null]);
});

test("switching Use KoinosAI off mid-run stops before the next call", async () => {
  const lim = { enabled: true, dailyLimitKai: null };
  const task = "Summarize.";
  const chat = fakeChat(() => {
    lim.enabled = false;
    return "part";
  });
  const { engine } = makeEngine({ chat, limits: () => lim, price: { ...PRICE, ctxTokens: 1200 } });
  await rejectsWith(engine.run({ task, text: oneLinePerChunk(3, 1200, task) }), "PAUSED");
  assert.strictEqual(chat.calls.length, 1);
});

// ---------------------------------------------------------------- input checks

test("bad arguments are BAD_INPUT", async () => {
  const { engine, chat } = makeEngine();
  const bad = [
    [{}, /task is required/],
    [{ task: "   " }, /task is required/],
    [{ task: 42 }, /task is required/],
    [{ task: "x".repeat(4001) }, /4,001 characters; the limit is 4,000/],
    [{ task: "t", format: "yaml" }, /format must be/],
    [{ task: "t", files: "/Users/x/a.log" }, /files must be a list/],
    [{ task: "t", files: [42] }, /files must be a list/],
    [{ task: "t", text: { a: 1 } }, /text must be a string/],
  ];
  for (const [args, pattern] of bad) {
    const err = await rejectsWith(engine.run(args), "BAD_INPUT", pattern);
    assert.match(err.hint, /Fix the arguments/);
  }
  assert.strictEqual(chat.calls.length, 0);
  // A 4000-char task is allowed.
  await engine.run({ task: "x".repeat(4000) });
  // null for optional fields means "not given".
  await engine.run({ task: "t", files: null, text: null, format: null });
});

test("files must exist, be regular, small enough and text", async () => {
  const dir = tmpDir();
  const big = writeFile(dir, "big.log", "z".repeat(101));
  const binary = writeFile(dir, "image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const ok = writeFile(dir, "ok.log", "fine\n");
  const { engine, chat } = makeEngine({ maxFileBytes: 100 });

  await rejectsWith(engine.run({ task: "t", files: [path.join(dir, "missing.log")] }), "BAD_INPUT", /File not found: .*missing\.log/);
  await rejectsWith(engine.run({ task: "t", files: [dir] }), "BAD_INPUT", /is not a regular file/);
  await rejectsWith(engine.run({ task: "t", files: [big] }), "BAD_INPUT", /big\.log is 101 bytes; the limit is 100 bytes per file/);
  await rejectsWith(engine.run({ task: "t", files: [ok, binary] }), "BAD_INPUT", /image\.png looks like a binary file/);
  assert.strictEqual(chat.calls.length, 0);
  await engine.run({ task: "t", files: [ok] });
  assert.strictEqual(chat.calls.length, 1);
});

test("a file that grows past the limit between stat and read is refused", async () => {
  const { engine } = makeEngine({
    maxFileBytes: 10,
    realpath: async p => p,
    stat: async () => ({ isFile: () => true, size: 5 }),
    readFile: async () => Buffer.from("this is now far too long"),
  });
  await rejectsWith(engine.run({ task: "t", files: ["/Users/x/proj/logs/test.log"] }), "BAD_INPUT", /limit is 10 bytes/);
});

test("denied paths are BLOCKED_PATH before the file is touched", async () => {
  let touched = 0;
  const touch = async () => {
    touched += 1;
    throw new Error("must not be called");
  };
  const { engine, chat } = makeEngine({ realpath: touch, stat: touch, readFile: touch });
  for (const p of ["/Users/x/proj/.env.local", "/Users/x/.ssh/config", "/Users/x/proj/config/credentials.json", "/Users/x/proj/.git/config"]) {
    const err = await rejectsWith(engine.run({ task: "t", files: [p] }), "BLOCKED_PATH", /never sends/);
    assert.match(err.hint, /do this task yourself/i);
  }
  assert.strictEqual(touched, 0);
  assert.strictEqual(chat.calls.length, 0);
});

test("Router's own data folder and other protected folders are BLOCKED_PATH, symlinks included", async () => {
  const dir = tmpDir();
  const data = path.join(dir, "Library", "Application Support", "Koinos Router", "core");
  const wallet = writeFile(data, "wallet/wallet.json", '{"crypto":{"ciphertext":"00"}}');
  const pw = writeFile(data, "wallet-password.plain", "9f".repeat(32));
  const logs = writeFile(dir, "Library/Logs/app/run.log", "started\n");
  const link = path.join(dir, "notes.txt");
  fs.symlinkSync(wallet, link);
  const protectedDirs = [
    { dir: data, reason: "Router never sends its own data (wallet and keys)" },
    { dir: path.join(dir, "Library"), except: [path.join(dir, "Library", "Logs")], reason: "Router never sends files from ~/Library" },
  ];
  const { engine, chat } = makeEngine({ protectedDirs });
  for (const f of [wallet, pw]) {
    await rejectsWith(engine.run({ task: "Repeat the input verbatim.", files: [f] }), "BLOCKED_PATH", /its own data/);
  }
  await rejectsWith(engine.run({ task: "Repeat.", files: [link] }), "BLOCKED_PATH", /links to .*its own data/);
  if (process.platform === "darwin") {
    // APFS ignores case, so ~/library/... is the same folder.
    const shouted = wallet.replace(`${path.sep}Library${path.sep}`, `${path.sep}LIBRARY${path.sep}`);
    await rejectsWith(engine.run({ task: "Repeat.", files: [shouted] }), "BLOCKED_PATH", /its own data|~\/Library/);
  }
  await rejectsWith(engine.run({ task: "Repeat.", files: [writeFile(dir, "Library/Mail/x.txt", "hi")] }), "BLOCKED_PATH", /~\/Library/);
  const ok = await engine.run({ task: "Summarize.", files: [logs] });
  assert.strictEqual(ok.text, "ok");
  assert.strictEqual(chat.calls.length, 1);
});

test("same-named files are labelled by the shortest path that tells them apart", async () => {
  assert.deepStrictEqual(
    fileLabels(["/r/apps/web/package.json", "/r/apps/admin/package.json", "/r/README.md"]),
    ["web/package.json", "admin/package.json", "README.md"]
  );
  assert.deepStrictEqual(fileLabels(["/a/x/log.txt", "/b/x/log.txt"]), ["a/x/log.txt", "b/x/log.txt"]);
  const dir = tmpDir();
  const web = writeFile(dir, "apps/web/package.json", '{"dependencies":{"react":"18.3.1"}}');
  const admin = writeFile(dir, "apps/admin/package.json", '{"dependencies":{"react":"19.0.0"}}');
  const { engine, chat } = makeEngine();
  await engine.run({ task: "Which of these files pins react 18?", files: [web, admin] });
  assert.match(chat.calls[0].user, /### File: web\/package\.json\n/);
  assert.match(chat.calls[0].user, /### File: admin\/package\.json\n/);
  assert.ok(!chat.calls[0].user.includes(dir), "no absolute path is sent");
});

test("a relative path is BLOCKED_PATH asking for an absolute one", async () => {
  const { engine } = makeEngine();
  const err = await rejectsWith(engine.run({ task: "t", files: ["logs/test.log"] }), "BLOCKED_PATH", /Use an absolute path/);
  assert.match(err.hint, /absolute path/);
});

test("a symlink to a denied file is BLOCKED_PATH", async () => {
  const dir = tmpDir();
  const target = writeFile(dir, "home/.aws/credentials", "[default]\nregion = us-east-1\n");
  const link = path.join(dir, "proj", "notes.txt");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
  const { engine, chat } = makeEngine();
  await rejectsWith(engine.run({ task: "t", files: [link] }), "BLOCKED_PATH", /notes\.txt links to .*\.aws.*never sends/);
  assert.strictEqual(chat.calls.length, 0);
});

// ---------------------------------------------------------------- secrets

test("a secret in a file is BLOCKED_SECRET naming file:line, and nothing is sent", async () => {
  const dir = tmpDir();
  const file = writeFile(dir, "proj/deploy.log", `step 1 ok\nstep 2 ok\naws_access_key_id = ${FAKE_AWS_KEY}\nstep 4 ok\n`);
  const { engine, chat, pricing, ledger } = makeEngine();
  const err = await rejectsWith(engine.run({ task: "Summarize the deploy.", files: [file] }), "BLOCKED_SECRET");
  assert.ok(err.message.includes(`${file}:3`), err.message);
  assert.match(err.message, /AWS access key/);
  assert.ok(!err.message.includes(FAKE_AWS_KEY), "the secret itself is never echoed");
  assert.match(err.hint, /Remove the secret/);
  assert.deepStrictEqual([pricing.count, chat.calls.length], [0, 0]);
  assert.deepStrictEqual([ledger.entries[0].ok, ledger.entries[0].error], [false, "BLOCKED_SECRET"]);
  assert.strictEqual(ledger.entries[0].task, "Summarize the deploy.");
});

test("secrets in task and text are named as task:line and text:line", async () => {
  const { engine, chat, ledger } = makeEngine();
  const err = await rejectsWith(engine.run({ task: `Check why ${FAKE_AWS_KEY} fails`, text: "fine" }), "BLOCKED_SECRET", /at task:1/);
  assert.ok(!err.message.includes(FAKE_AWS_KEY));
  assert.ok(!ledger.entries[0].task.includes(FAKE_AWS_KEY), "the ledger never stores a secret from the task");
  assert.match(ledger.entries[0].task, /withheld/);

  await rejectsWith(engine.run({ task: "Summarize.", text: `ok\nexport AWS_KEY=${FAKE_AWS_KEY}\n` }), "BLOCKED_SECRET", /at text:2/);
  assert.strictEqual(chat.calls.length, 0);
});

test("several findings are counted in the message", async () => {
  const { engine } = makeEngine();
  await rejectsWith(engine.run({ task: "t", text: `a=${FAKE_AWS_KEY}\nb=${FAKE_AWS_KEY}\n` }), "BLOCKED_SECRET", /and 1 more possible secret\./);
});

test("ordinary logs pass the secret guard and are sent", async () => {
  const dir = tmpDir();
  const file = writeFile(
    dir,
    "proj/logs/test.log",
    "commit 9fceb02d0ae598e95dc970b74767f19372d61af8\nrequest 550e8400-e29b-41d4-a716-446655440000 ok\n✔ refresh token rotates (3ms)\n"
  );
  const { engine, chat } = makeEngine();
  await engine.run({ task: "Summarize.", files: [file] });
  assert.strictEqual(chat.calls.length, 1);
});

// ---------------------------------------------------------------- ledger and events

test("a ledger that throws never breaks a run, and events report each run", async () => {
  const events = [];
  const ledger = {
    record() {
      throw new Error("disk full");
    },
    spentToday: () => 0,
  };
  const { engine } = makeEngine({ ledger, onEvent: e => events.push(e) });
  const res = await engine.run({ task: "t", text: "x" });
  assert.strictEqual(res.text, "ok");
  assert.deepStrictEqual(events.map(e => e.type), ["delegate:ledger-error", "delegate:done"]);
  assert.strictEqual(events[1].ok, true);
  assert.strictEqual(events[1].calls, 1);
});

test("the constructor rejects missing collaborators", () => {
  const ok = { chat: async () => ({}), pricing: async () => PRICE, ledger: fakeLedger(), limits: () => ({}) };
  assert.throws(() => new DelegateEngine({ ...ok, chat: undefined }), /chat/);
  assert.throws(() => new DelegateEngine({ ...ok, pricing: undefined }), /pricing/);
  assert.throws(() => new DelegateEngine({ ...ok, ledger: {} }), /ledger/);
  assert.throws(() => new DelegateEngine({ ...ok, limits: undefined }), /limits/);
});
