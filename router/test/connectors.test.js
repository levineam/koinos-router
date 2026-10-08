"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  Connectors, SKILL_MARKER, SKILL_SOURCE, BACKUP_SUFFIX, defaultWhich, toml, json,
} = require("../lib/connectors");

const TOKEN = "ab12".repeat(16);
const URL_A = `http://127.0.0.1:41110/mcp/${TOKEN}`;
const URL_OLD = "http://127.0.0.1:9999/mcp/old";
const SKILL = fs.readFileSync(SKILL_SOURCE, "utf8");

const read = p => fs.readFileSync(p, "utf8");
const exists = p => fs.existsSync(p);
const shQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`;

// ---- fake CLIs: each records its argv and HOME, then edits the fake config
// the way the real CLI does. They run as real processes through the default exec.

function fakeCodex(MODE, LOG) {
  const fs = require("fs");
  const path = require("path");
  const args = process.argv.slice(2);
  fs.appendFileSync(LOG, JSON.stringify({ cli: "codex", args, home: process.env.HOME }) + "\n");
  if (MODE === "fail") {
    process.stderr.write("codex failed: " + args.join(" ") + "\n");
    process.exit(1);
  }
  if (MODE === "noop") return;
  const file = path.join(process.env.HOME, ".codex", "config.toml");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  let skip = false;
  const strip = t => t.split(/(?<=\n)/).filter((line) => {
    if (line.startsWith("[")) skip = /^\[mcp_servers\.koinos[\].]/.test(line);
    return !skip;
  }).join("");
  if (args[0] === "mcp" && args[1] === "remove") {
    if (!/^\[mcp_servers\.koinos\]/m.test(text)) {
      process.stderr.write("Error: No MCP server named 'koinos' found.\n");
      process.exit(1);
    }
    fs.writeFileSync(file, strip(text));
    return;
  }
  if (args[0] === "mcp" && args[1] === "add") {
    const url = args[args.indexOf("--url") + 1];
    let out = strip(text);
    if (out && !out.endsWith("\n")) out += "\n";
    if (out) out += "\n";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out + "[mcp_servers." + args[2] + "]\nurl = \"" + url + "\"\n");
    return;
  }
  process.exit(2);
}

function fakeClaude(MODE, LOG) {
  const fs = require("fs");
  const path = require("path");
  const args = process.argv.slice(2);
  fs.appendFileSync(LOG, JSON.stringify({ cli: "claude", args, home: process.env.HOME }) + "\n");
  if (MODE === "fail") {
    process.stderr.write("claude failed: " + args.join(" ") + "\n");
    process.exit(1);
  }
  if (MODE === "noop") return;
  const file = path.join(process.env.HOME, ".claude.json");
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const save = () => fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const userScope = args.includes("--scope") && args[args.indexOf("--scope") + 1] === "user";
  if (args[0] === "mcp" && args[1] === "remove" && userScope) {
    const name = args[args.length - 1];
    if (!data.mcpServers || !data.mcpServers[name]) {
      process.stderr.write("No user-scoped MCP server found with name: " + name + "\n");
      process.exit(1);
    }
    delete data.mcpServers[name];
    save();
    return;
  }
  if (args[0] === "mcp" && args[1] === "add" && userScope && args.includes("http")) {
    const [name, url] = args.slice(-2);
    data.mcpServers = data.mcpServers || {};
    data.mcpServers[name] = { type: "http", url };
    save();
    return;
  }
  process.exit(2);
}

const FAKES = { codex: fakeCodex, claude: fakeClaude };

function makeFakeCli(binDir, name, mode, log) {
  const impl = path.join(binDir, `${name}.impl.js`);
  fs.writeFileSync(impl, `(${FAKES[name].toString()})(${JSON.stringify(mode)}, ${JSON.stringify(log)});\n`);
  const bin = path.join(binDir, name);
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(impl)} "$@"\n`, { mode: 0o755 });
  return bin;
}

/** codex/claude: null (not installed) or a fake CLI mode: "ok" | "noop" | "fail". */
function setup({ codex = null, claude = null, url = URL_A, exec } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "router-connectors-"));
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(binDir);
  const log = path.join(root, "cli.log");
  const bins = {};
  if (codex) bins.codex = makeFakeCli(binDir, "codex", codex, log);
  if (claude) bins.claude = makeFakeCli(binDir, "claude", claude, log);
  const events = [];
  const state = { url };
  const connectors = new Connectors({
    home,
    mcpUrl: () => state.url,
    which: async name => bins[name] || null,
    onEvent: e => events.push(e),
    ...(exec ? { exec } : {}),
  });
  const calls = () => (exists(log) ? read(log).trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
  const p = (...parts) => path.join(home, ...parts);
  return { root, home, bins, events, state, connectors, calls, p };
}

const codexTable = url => `[mcp_servers.koinos]\nurl = "${url}"\ntool_timeout_sec = 240\n`;
const off = { found: false, connected: false, method: null };

// ---- detection

test("nothing installed: not found, connect refuses, home stays untouched", async () => {
  const s = setup();
  assert.deepEqual(await s.connectors.status(), { codex: off, claude: off });
  for (const tool of ["codex", "claude"]) {
    await assert.rejects(s.connectors.connect(tool), (err) => {
      assert.equal(err.code, "NOT_FOUND");
      assert.equal(err.status, 404);
      assert.match(err.message, tool === "codex" ? /^Codex isn't installed/ : /^Claude Code isn't installed/);
      return true;
    });
  }
  assert.deepEqual(fs.readdirSync(s.home), []);
});

test("unknown tool and a missing MCP URL are refused", async () => {
  const s = setup({ url: null });
  fs.mkdirSync(s.p(".codex"));
  await assert.rejects(s.connectors.connect("cursor"), { code: "BAD_TOOL", status: 400 });
  await assert.rejects(s.connectors.disconnect(undefined), { code: "BAD_TOOL", status: 400 });
  await assert.rejects(s.connectors.connect("codex"), { code: "NOT_READY", status: 503 });
  assert.equal(exists(s.p(".codex", "config.toml")), false);
});

test("found via config dirs alone; ~/.claude.json also counts for Claude Code", async () => {
  const s = setup();
  fs.mkdirSync(s.p(".codex"));
  fs.writeFileSync(s.p(".claude.json"), "{}\n");
  const st = await s.connectors.status();
  assert.deepEqual(st.codex, { found: true, connected: false, method: null });
  assert.deepEqual(st.claude, { found: true, connected: false, method: null });
});

// ---- file method

test("codex via ~/.codex only: creates config.toml from scratch and installs the skill", async () => {
  const s = setup();
  fs.mkdirSync(s.p(".codex"));
  const result = await s.connectors.connect("codex");
  assert.deepEqual(result.codex, { found: true, connected: true, method: "file" });
  assert.deepEqual(result.claude, off);
  assert.equal(read(s.p(".codex", "config.toml")), codexTable(URL_A));
  assert.equal(exists(s.p(".codex", "config.toml" + BACKUP_SUFFIX)), false, "nothing to back up");
  assert.equal(read(s.p(".codex", "skills", "koinos-delegate", "SKILL.md")), SKILL);
  assert.deepEqual(await s.connectors.status(), result);
  assert.deepEqual(s.calls(), []);
  assert.ok(s.events.some(e => e.type === "connectors:connected" && e.tool === "codex" && e.method === "file"));
});

test("codex file edit replaces a stale koinos table and sub-table, keeping every other byte", async () => {
  const s = setup();
  fs.mkdirSync(s.p(".codex"));
  const original = [
    'model = "gpt-5"',
    "# top comment",
    "",
    "[mcp_servers.alpha]",
    'command = "npx"',
    'args = ["-y", "alpha"]',
    "",
    "[mcp_servers.koinos]",
    `url = '${URL_OLD}'`,
    "tool_timeout_sec = 30",
    "",
    "[mcp_servers.koinos.env]",
    'KEY = "1"',
    "",
    "# beta is my other server",
    "[mcp_servers.beta]",
    'url = "https://beta.example/mcp"',
    "",
    "[profiles.fast]",
    'model = "gpt-5-mini"',
    "",
  ].join("\n");
  const file = s.p(".codex", "config.toml");
  fs.writeFileSync(file, original);

  assert.deepEqual((await s.connectors.status()).codex, { found: true, connected: false, method: null });
  const result = await s.connectors.connect("codex");
  assert.deepEqual(result.codex, { found: true, connected: true, method: "file" });

  const expected = [
    'model = "gpt-5"',
    "# top comment",
    "",
    "[mcp_servers.alpha]",
    'command = "npx"',
    'args = ["-y", "alpha"]',
    "",
    "# beta is my other server",
    "[mcp_servers.beta]",
    'url = "https://beta.example/mcp"',
    "",
    "[profiles.fast]",
    'model = "gpt-5-mini"',
    "",
    "",
  ].join("\n") + codexTable(URL_A);
  assert.equal(read(file), expected);
  assert.equal(read(file + BACKUP_SUFFIX), original);

  // Reconnecting rewrites nothing and never replaces the first backup.
  await s.connectors.connect("codex");
  assert.equal(read(file), expected);
  assert.equal(read(file + BACKUP_SUFFIX), original);
});

test("claude via ~/.claude.json only: adds mcpServers.koinos and keeps all other keys", async () => {
  const s = setup();
  const original = {
    numStartups: 42,
    theme: "dark",
    mcpServers: { github: { type: "stdio", command: "gh-mcp", args: [] } },
    projects: { "/Users/x/repo": { allowedTools: ["Bash"], mcpServers: { local: { url: "http://x" } } } },
  };
  const file = s.p(".claude.json");
  const originalText = JSON.stringify(original, null, 2) + "\n";
  fs.writeFileSync(file, originalText, { mode: 0o600 });

  const result = await s.connectors.connect("claude");
  assert.deepEqual(result.claude, { found: true, connected: true, method: "file" });

  const expected = structuredClone(original);
  expected.mcpServers.koinos = { type: "http", url: URL_A, timeout: 240000 };
  assert.equal(read(file), JSON.stringify(expected, null, 2) + "\n");
  assert.deepEqual(Object.keys(JSON.parse(read(file))), Object.keys(original), "key order kept");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(read(file + BACKUP_SUFFIX), originalText);
  assert.equal(read(s.p(".claude", "skills", "koinos-delegate", "SKILL.md")), SKILL);
});

test("claude file edit adds mcpServers when absent and keeps a missing trailing newline missing", async () => {
  const s = setup();
  fs.writeFileSync(s.p(".claude.json"), '{\n  "a": 1\n}');
  await s.connectors.connect("claude");
  assert.equal(read(s.p(".claude.json")),
    JSON.stringify({ a: 1, mcpServers: { koinos: { type: "http", url: URL_A, timeout: 240000 } } }, null, 2));
});

test("an invalid ~/.claude.json is left alone and the connect fails with a clear error", async () => {
  const s = setup();
  fs.writeFileSync(s.p(".claude.json"), "{ not json");
  await assert.rejects(s.connectors.connect("claude"), (err) => {
    assert.equal(err.code, "BAD_CONFIG");
    assert.equal(err.status, 409);
    assert.match(err.message, /~\/\.claude\.json isn't valid JSON/);
    return true;
  });
  assert.equal(read(s.p(".claude.json")), "{ not json");
  assert.deepEqual((await s.connectors.status()).claude, { found: true, connected: false, method: null });
});

// ---- CLI method

test("codex with its CLI installed: config.toml is still edited in place, byte for byte, and the CLI never runs", async () => {
  // `codex mcp add/remove` re-serializes the whole file: CRLF → LF, comments
  // in [mcp_servers.*] dropped, 30 → 30.0. Router's own edit keeps all of it.
  const s = setup({ codex: "ok" });
  fs.mkdirSync(s.p(".codex"));
  const original = [
    'model = "gpt-5"',
    "# github server (keep this comment)",
    "[mcp_servers.github]",
    'command = "github-mcp"',
    "startup_timeout_sec = 30",
    "",
    "[mcp_servers.github.env]",
    'GITHUB_HOST = "github.com"',
    "",
    "[sandbox_workspace_write]",
    "writable_roots = [",
    '  "/tmp/a",',
    '  "/tmp/b",',
    "]",
    "",
    '[projects."/Users/x/proj"]',
    'trust_level = "trusted"',
    "",
  ].join("\r\n");
  const file = s.p(".codex", "config.toml");
  fs.writeFileSync(file, original);

  const result = await s.connectors.connect("codex");
  assert.deepEqual(result.codex, { found: true, connected: true, method: "file" });
  assert.deepEqual(s.calls(), [], "codex mcp add/remove never ran");
  const table = codexTable(URL_A).replace(/\n/g, "\r\n");
  assert.equal(read(file), original + "\r\n" + table);
  assert.equal(read(file + BACKUP_SUFFIX), original);
  assert.equal(read(s.p(".codex", "skills", "koinos-delegate", "SKILL.md")), SKILL);
  assert.deepEqual((await s.connectors.status()).codex, { found: true, connected: true, method: "file" });
  assert.equal(await s.connectors.configuredUrl("codex"), URL_A);

  // Disconnect removes only our table and still never runs the CLI.
  await s.connectors.disconnect("codex");
  assert.deepEqual(s.calls(), []);
  assert.equal(read(file), original + "\r\n");
  assert.equal(await s.connectors.configuredUrl("codex"), null);
});

test("codex falls back to its CLI only when Router can't write config.toml", { skip: process.getuid?.() === 0 }, async () => {
  const s = setup({ codex: "ok" });
  fs.mkdirSync(s.p(".codex"));
  const file = s.p(".codex", "config.toml");
  fs.writeFileSync(file, 'model = "gpt-5"\n');
  // Router writes atomically (temp file + rename), which a read-only folder
  // refuses; the CLI rewrites the file in place, which still works.
  fs.chmodSync(s.p(".codex"), 0o500);
  try {
    const result = await s.connectors.connect("codex");
    assert.deepEqual(result.codex, { found: true, connected: true, method: "cli" });
    assert.ok(s.events.some(e => e.type === "connectors:file-failed"));
    assert.deepEqual(s.calls().map(c => c.args.slice(0, 2)), [["mcp", "remove"], ["mcp", "add"]]);
    assert.ok(!JSON.stringify(s.events).includes(TOKEN), "token redacted");
  } finally {
    fs.chmodSync(s.p(".codex"), 0o700);
  }
});

test("claude CLI happy path: user-scope remove and add, timeout patched in", async () => {
  const s = setup({ claude: "ok" });
  const result = await s.connectors.connect("claude");
  assert.deepEqual(result.claude, { found: true, connected: true, method: "cli" });
  assert.deepEqual(s.calls(), [
    { cli: "claude", args: ["mcp", "remove", "--scope", "user", "koinos"], home: s.home },
    { cli: "claude", args: ["mcp", "add", "--transport", "http", "--scope", "user", "koinos", URL_A], home: s.home },
  ]);
  assert.deepEqual(JSON.parse(read(s.p(".claude.json"))),
    { mcpServers: { koinos: { type: "http", url: URL_A, timeout: 240000 } } });
  assert.equal(read(s.p(".claude", "skills", "koinos-delegate", "SKILL.md")), SKILL);
  // There was no config before the CLI ran, so the timeout patch must not
  // "back up" the CLI's own edit as if it were the user's original.
  assert.equal(exists(s.p(".claude.json" + BACKUP_SUFFIX)), false);
});

test("a CLI that reports success but writes nothing falls back to the file edit", async () => {
  const s = setup({ codex: "noop", claude: "noop" });
  const result = await s.connectors.connect("codex");
  assert.deepEqual(result.codex, { found: true, connected: true, method: "file" });
  assert.equal(read(s.p(".codex", "config.toml")), codexTable(URL_A));

  const both = await s.connectors.connect("claude");
  assert.deepEqual(both.claude, { found: true, connected: true, method: "file" });
  assert.equal(JSON.parse(read(s.p(".claude.json"))).mcpServers.koinos.url, URL_A);

  assert.deepEqual(s.calls().map(c => c.cli), ["claude", "claude"], "codex is edited directly");
  assert.equal(s.events.filter(e => e.type === "connectors:cli-fallback").length, 1);
  assert.equal(exists(s.p(".codex", "config.toml" + BACKUP_SUFFIX)), false);
  assert.equal(exists(s.p(".claude.json" + BACKUP_SUFFIX)), false);
});

test("a failing CLI with no ~/.claude.json yet: the fallback creates it, and events never carry the token", async () => {
  const s = setup({ claude: "fail" });
  assert.deepEqual((await s.connectors.status()).claude, { found: true, connected: false, method: null });
  const result = await s.connectors.connect("claude");
  assert.deepEqual(result.claude, { found: true, connected: true, method: "file" });
  assert.equal(JSON.parse(read(s.p(".claude.json"))).mcpServers.koinos.url, URL_A);
  const failed = s.events.filter(e => e.type === "connectors:cli-failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].step, "add");
  assert.match(failed[0].message, /claude failed/);
  assert.ok(!JSON.stringify(s.events).includes(TOKEN), "token redacted");
});

test("a CLI-made entry gets its timeout raised but keeps a larger one the user set", () => {
  const cli = `[mcp_servers.koinos]\nurl = "${URL_A}"\n\n[other]\nx = 1\n`;
  assert.equal(toml.ensureCodexTimeout(cli),
    `[mcp_servers.koinos]\nurl = "${URL_A}"\ntool_timeout_sec = 240\n\n[other]\nx = 1\n`);
  const low = `[mcp_servers.koinos]\ntool_timeout_sec = 60 # default\nurl = "${URL_A}"`;
  assert.equal(toml.ensureCodexTimeout(low), `[mcp_servers.koinos]\ntool_timeout_sec = 240\nurl = "${URL_A}"`);
  const high = `[mcp_servers.koinos]\nurl = "${URL_A}"\ntool_timeout_sec = 600\n`;
  assert.equal(toml.ensureCodexTimeout(high), high);
  const noNewline = `[mcp_servers.koinos]\nurl = "${URL_A}"`;
  assert.equal(toml.ensureCodexTimeout(noNewline), `${noNewline}\ntool_timeout_sec = 240\n`);
  assert.equal(toml.ensureCodexTimeout("[a]\nb = 1\n"), "[a]\nb = 1\n");

  const claude = JSON.stringify({ mcpServers: { koinos: { type: "http", url: URL_A } } }, null, 2);
  assert.equal(JSON.parse(json.ensureClaudeTimeout(claude)).mcpServers.koinos.timeout, 240000);
  const big = JSON.stringify({ mcpServers: { koinos: { url: URL_A, timeout: 900000 } } }, null, 2);
  assert.equal(json.ensureClaudeTimeout(big), big);
});

// ---- disconnect

test("disconnect removes the server entries and our skill folders", async () => {
  const s = setup({ claude: "ok" });
  fs.mkdirSync(s.p(".codex"));
  const codexOriginal = 'model = "gpt-5"\n';
  fs.writeFileSync(s.p(".codex", "config.toml"), codexOriginal);
  fs.writeFileSync(s.p(".claude.json"), JSON.stringify({ keep: true, mcpServers: { other: { url: "x" } } }, null, 2));

  await s.connectors.connect("codex");
  await s.connectors.connect("claude");
  const codexSkill = s.p(".codex", "skills", "koinos-delegate");
  const claudeSkill = s.p(".claude", "skills", "koinos-delegate");
  fs.writeFileSync(path.join(codexSkill, ".DS_Store"), "");
  assert.ok(exists(claudeSkill));

  let result = await s.connectors.disconnect("codex");
  assert.deepEqual(result.codex, { found: true, connected: false, method: null });
  assert.equal(read(s.p(".codex", "config.toml")), codexOriginal + "\n", "only our table is gone");
  assert.equal(exists(codexSkill), false);
  assert.ok(exists(s.p(".codex", "skills")), "the skills dir itself stays");

  result = await s.connectors.disconnect("claude");
  assert.deepEqual(result.claude, { found: true, connected: false, method: null });
  assert.deepEqual(s.calls().slice(-1), [
    { cli: "claude", args: ["mcp", "remove", "--scope", "user", "koinos"], home: s.home },
  ]);
  assert.deepEqual(JSON.parse(read(s.p(".claude.json"))), { keep: true, mcpServers: { other: { url: "x" } } });
  assert.equal(exists(claudeSkill), false);

  // Nothing left to remove: no CLI call, no error.
  const before = s.calls().length;
  await s.connectors.disconnect("claude");
  assert.equal(s.calls().length, before);
});

test("disconnect falls back to the file edit when the CLI leaves the entry behind", async () => {
  const s = setup({ codex: "fail", claude: "fail" });
  fs.mkdirSync(s.p(".codex"));
  fs.writeFileSync(s.p(".codex", "config.toml"), `x = 1\n\n[mcp_servers.koinos]\nurl = "${URL_OLD}"\n`);
  fs.writeFileSync(s.p(".claude.json"), JSON.stringify({ keep: 1, mcpServers: { koinos: { url: URL_OLD } } }, null, 2) + "\n");
  await s.connectors.disconnect("codex");
  await s.connectors.disconnect("claude");
  assert.deepEqual(s.calls().map(c => [c.cli, ...c.args]), [["claude", "mcp", "remove", "--scope", "user", "koinos"]]);
  assert.equal(read(s.p(".codex", "config.toml")), "x = 1\n\n");
  assert.deepEqual(JSON.parse(read(s.p(".claude.json"))), { keep: 1, mcpServers: {} });
});

test("a foreign koinos-delegate skill (no marker) is never overwritten or deleted", async () => {
  const s = setup();
  const dir = s.p(".claude", "skills", "koinos-delegate");
  fs.mkdirSync(dir, { recursive: true });
  const mine = "---\nname: koinos-delegate\ndescription: my own\n---\nhands off\n";
  fs.writeFileSync(path.join(dir, "SKILL.md"), mine);

  await s.connectors.connect("claude");
  assert.equal(read(path.join(dir, "SKILL.md")), mine);
  assert.ok(s.events.some(e => e.type === "connectors:skill-skipped" && e.tool === "claude"));

  await s.connectors.disconnect("claude");
  assert.equal(read(path.join(dir, "SKILL.md")), mine);
  assert.equal(JSON.parse(read(s.p(".claude.json"))).mcpServers.koinos, undefined);
});

test("files the user added to our skill folder survive disconnect", async () => {
  const s = setup();
  fs.mkdirSync(s.p(".codex"));
  await s.connectors.connect("codex");
  const dir = s.p(".codex", "skills", "koinos-delegate");
  assert.ok(read(path.join(dir, "SKILL.md")).includes(SKILL_MARKER));
  fs.writeFileSync(path.join(dir, "notes.md"), "mine");
  await s.connectors.disconnect("codex");
  assert.deepEqual(fs.readdirSync(dir), ["notes.md"]);
});

// ---- status

test("status: a koinos entry with another URL is not connected", async () => {
  const s = setup();
  fs.mkdirSync(s.p(".codex"));
  fs.writeFileSync(s.p(".codex", "config.toml"), `[mcp_servers.koinos]\nurl = "${URL_OLD}"\n`);
  fs.writeFileSync(s.p(".claude.json"), JSON.stringify({ mcpServers: { koinos: { type: "http", url: URL_OLD } } }));
  assert.deepEqual(await s.connectors.status(), {
    codex: { found: true, connected: false, method: null },
    claude: { found: true, connected: false, method: null },
  });

  // Same URL in single quotes with loose spacing and a comment still counts.
  fs.writeFileSync(s.p(".codex", "config.toml"), `[ mcp_servers.koinos ]  # router\n  url='${URL_A}'   # ours\n`);
  fs.writeFileSync(s.p(".claude.json"), JSON.stringify({ mcpServers: { koinos: { type: "http", url: URL_A } } }));
  assert.deepEqual(await s.connectors.status(), {
    codex: { found: true, connected: true, method: "file" },
    claude: { found: true, connected: true, method: "file" },
  });

  // The port moved: the stored URL no longer matches.
  s.state.url = URL_A.replace("41110", "52001");
  const moved = await s.connectors.status();
  assert.equal(moved.codex.connected, false);
  assert.equal(moved.claude.connected, false);
});

test("status reads only the koinos table's url, not a sub-table's or another server's", async () => {
  const s = setup();
  fs.mkdirSync(s.p(".codex"));
  fs.writeFileSync(s.p(".codex", "config.toml"),
    `[mcp_servers.koinos2]\nurl = "${URL_A}"\n\n[mcp_servers.koinos]\ncommand = "x"\n\n[mcp_servers.koinos.env]\nurl = "${URL_A}"\n`);
  assert.equal((await s.connectors.status()).codex.connected, false);
});

// ---- plumbing

test("default which asks a login shell and returns only an absolute executable path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "router-which-"));
  const target = path.join(root, "codex");
  fs.writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
  const shell = path.join(root, "fake-shell");
  const argsLog = path.join(root, "args");
  fs.writeFileSync(shell, [
    "#!/bin/sh",
    `printf '%s|%s\\n' "$1" "$2" >> ${shQuote(argsLog)}`,
    'echo "Welcome banner"',
    `[ "$2" = "command -v codex" ] && { echo ${shQuote(target)}; exit 0; }`,
    `[ "$2" = "command -v claude" ] && { echo "alias claude=/nowhere"; exit 0; }`,
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });

  const saved = process.env.SHELL;
  process.env.SHELL = shell;
  try {
    assert.equal(await defaultWhich("codex"), target);
    assert.equal(await defaultWhich("claude"), null);
    assert.equal(await defaultWhich("missing"), null);
    assert.equal(await defaultWhich("codex; rm -rf /"), null);
  } finally {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  }
  assert.deepEqual(read(argsLog).trim().split("\n"),
    ["-lc|command -v codex", "-lc|command -v claude", "-lc|command -v missing"]);
});

test("an injected exec gets the CLI path, a 20 s timeout and HOME; a throwing which means not found", async () => {
  const seen = [];
  const s = setup({
    claude: "ok",
    exec: async (file, args, opts) => {
      seen.push({ file, args, home: opts.env.HOME, timeout: opts.timeout, path: opts.env.PATH });
      return { stdout: "", stderr: "" };
    },
  });
  const result = await s.connectors.connect("claude");
  assert.equal(result.claude.method, "file", "the injected exec wrote nothing");
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.file, s.bins.claude);
    assert.equal(call.home, s.home);
    assert.equal(call.timeout, 20000);
    assert.ok(call.path.startsWith(path.dirname(s.bins.claude) + path.delimiter));
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-connectors-"));
  const events = [];
  const c = new Connectors({ home, mcpUrl: () => URL_A, which: async () => { throw new Error("no shell"); },
    onEvent: e => events.push(e) });
  assert.deepEqual(await c.status(), { codex: off, claude: off });
  assert.ok(events.some(e => e.type === "connectors:which-failed"));
});

test("a symlinked config is edited through the link", async () => {
  const s = setup();
  fs.mkdirSync(s.p(".codex"));
  const real = path.join(s.root, "dotfiles", "config.toml");
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, "a = 1\n");
  fs.symlinkSync(real, s.p(".codex", "config.toml"));
  await s.connectors.connect("codex");
  assert.ok(fs.lstatSync(s.p(".codex", "config.toml")).isSymbolicLink());
  assert.equal(read(real), "a = 1\n\n" + codexTable(URL_A));
});

test("concurrent connects are serialized and leave exactly one koinos table", async () => {
  const s = setup({ codex: "ok" });
  await Promise.all([s.connectors.connect("codex"), s.connectors.connect("codex"), s.connectors.status()]);
  const text = read(s.p(".codex", "config.toml"));
  assert.equal(text.match(/\[mcp_servers\.koinos\]/g).length, 1);
  assert.equal(text.match(/tool_timeout_sec/g).length, 1);
});

test("TOML helpers: no trailing newline, CRLF files, empty files", () => {
  assert.equal(toml.setCodexServer("", URL_A), codexTable(URL_A));
  assert.equal(toml.setCodexServer("a = 1", URL_A), "a = 1\n\n" + codexTable(URL_A));
  assert.equal(toml.setCodexServer("a = 1\n\n", URL_A), "a = 1\n\n" + codexTable(URL_A));
  assert.equal(toml.setCodexServer("a = 1\r\n", URL_A), "a = 1\r\n\r\n" + codexTable(URL_A).replace(/\n/g, "\r\n"));
  assert.equal(toml.codexUrl(toml.setCodexServer("a = 1\r\n", URL_A)), URL_A);
  // Removing at end of file takes trailing comments with it; mid-file they stay with the next table.
  assert.equal(toml.removeCodexServer(`[x]\n\n[mcp_servers.koinos]\nurl = "u"\n# old note\n`), "[x]\n\n");
  assert.equal(toml.removeCodexServer('[mcp_servers."koinos"]\nurl = "u"\n\n# y\n[y]\n'), "# y\n[y]\n");
  assert.equal(toml.removeCodexServer("[mcp_servers.koinos_beta]\nurl = 'u'\n"), "[mcp_servers.koinos_beta]\nurl = 'u'\n");
  assert.equal(toml.codexUrl('[mcp_servers.koinos]\nurl = "http://h/\\u0041"\n'), "http://h/A");
});
