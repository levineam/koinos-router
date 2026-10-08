"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("node:crypto");
const childProcess = require("child_process");

/*
 * Connects Codex and Claude Code to Router's MCP endpoint and installs the
 * koinos-delegate skill into each.
 *
 * Claude Code: its own CLI is preferred because it knows its config format
 * (and ~/.claude.json round-trips through it losslessly). Codex: Router edits
 * ~/.codex/config.toml itself, because `codex mcp add/remove` re-serializes
 * the whole file (CRLF → LF, comments in [mcp_servers.*] dropped, numbers
 * reformatted); its CLI is only the fallback when the file can't be written.
 * A CLI is never trusted to have worked: status always comes from reading the
 * config files, and when a CLI leaves no matching entry behind Router edits
 * the file itself. File edits touch only the koinos entry; every other byte
 * of the user's config survives.
 */

const SERVER = "koinos";
const SKILL_NAME = "koinos-delegate";
const SKILL_SOURCE = path.join(__dirname, "skill", "SKILL.md");
const SKILL_MARKER = "<!-- installed by Koinos Router -->";
const BACKUP_SUFFIX = ".koinos-router.bak";
const TOOLS = ["codex", "claude"];
const EXEC_TIMEOUT_MS = 20_000;
const WHICH_TIMEOUT_MS = 5_000;
const WHICH_TTL_MS = 60_000;
// Map-reduce delegations can run for 180 s; both harnesses time tools out sooner.
const CODEX_TOOL_TIMEOUT_SEC = 240;
const CLAUDE_TIMEOUT_MS = 240_000;

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

function userError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// ---- TOML (~/.codex/config.toml), line-based so untouched bytes stay as they are

const TOML_HEADER = /^\s*\[\[?[^[\]]*\]\]?\s*(?:#.*)?\s*$/;
const KOINOS_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:koinos|"koinos"|'koinos')\s*(\]|\.)/;
const TOML_URL = /^\s*(?:url|"url"|'url')\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?\s*$/;
const TOML_TIMEOUT = /^\s*tool_timeout_sec\s*=\s*([^\s#]*)/;
const TOML_BLANK_OR_COMMENT = /^\s*(?:#.*)?\s*$/;
const TOML_COMMENT = /^\s*#/;

/** Lines with their terminators, so join("") gives back the exact input. */
function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

const eolOf = text => (text.includes("\r\n") ? "\r\n" : "\n");
const lineEnd = line => (line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "");
const isHeader = line => TOML_HEADER.test(line);

// Comments directly above a following foreign table read as that table's
// ("# github" over [mcp_servers.github]), so removing ours must keep them.
function spanEnd(lines, bodyStart, end) {
  if (end >= lines.length || KOINOS_HEADER.test(lines[end])) return end;
  let firstComment = -1;
  for (let i = end - 1; i >= bodyStart && TOML_BLANK_OR_COMMENT.test(lines[i]); i--) {
    if (TOML_COMMENT.test(lines[i])) firstComment = i;
  }
  return firstComment === -1 ? end : firstComment;
}

/** [mcp_servers.koinos] and its [mcp_servers.koinos.*] sub-tables; a table runs to the next header. */
function koinosSpans(lines) {
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const m = isHeader(lines[i]) ? KOINOS_HEADER.exec(lines[i]) : null;
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && !isHeader(lines[end])) end++;
    spans.push({ start: i, end: spanEnd(lines, i + 1, end), main: m[1] === "]" });
    i = end - 1;
  }
  return spans;
}

function unescapeBasic(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

function codexUrl(text) {
  const lines = splitLines(text);
  const main = koinosSpans(lines).find(s => s.main);
  if (!main) return null;
  for (let i = main.start + 1; i < main.end; i++) {
    const m = TOML_URL.exec(lines[i]);
    if (m) return m[1] !== undefined ? unescapeBasic(m[1]) : m[2];
  }
  return null;
}

const hasCodexServer = text => koinosSpans(splitLines(text)).length > 0;

function removeCodexServer(text) {
  const lines = splitLines(text);
  const spans = koinosSpans(lines);
  if (spans.length === 0) return text;
  const drop = new Set();
  for (const { start, end } of spans) for (let i = start; i < end; i++) drop.add(i);
  return lines.filter((_, i) => !drop.has(i)).join("");
}

function setCodexServer(text, url) {
  const eol = eolOf(text);
  const table = `[mcp_servers.${SERVER}]${eol}url = ${JSON.stringify(url)}${eol}` +
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}${eol}`;
  const rest = removeCodexServer(text);
  if (!/\S/.test(rest)) return rest + table;
  let out = rest.endsWith("\n") ? rest : rest + eol;
  if (!out.endsWith(eol + eol)) out += eol;
  return out + table;
}

// `codex mcp add` has no timeout flag, so the key is patched into the table the
// CLI wrote. A larger value the user chose is left alone.
function ensureCodexTimeout(text) {
  const lines = splitLines(text);
  const main = koinosSpans(lines).find(s => s.main);
  if (!main) return text;
  const eol = eolOf(text);
  const want = `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`;
  let urlAt = -1;
  for (let i = main.start + 1; i < main.end; i++) {
    const t = TOML_TIMEOUT.exec(lines[i]);
    if (t) {
      if (Number(t[1]) >= CODEX_TOOL_TIMEOUT_SEC) return text;
      lines[i] = want + lineEnd(lines[i]);
      return lines.join("");
    }
    if (urlAt === -1 && TOML_URL.test(lines[i])) urlAt = i;
  }
  const at = urlAt === -1 ? main.start : urlAt;
  if (!lines[at].endsWith("\n")) lines[at] += eol;
  lines.splice(at + 1, 0, want + eol);
  return lines.join("");
}

// ---- JSON (~/.claude.json)

function parseJsonConfig(text) {
  if (!/\S/.test(text)) return {};
  const data = JSON.parse(text);
  if (!isPlainObject(data)) throw new SyntaxError("Top level is not an object");
  return data;
}

function serializeJson(data, original) {
  return JSON.stringify(data, null, 2) + (original === "" || original.endsWith("\n") ? "\n" : "");
}

function claudeEntry(data) {
  const servers = data.mcpServers;
  if (!isPlainObject(servers) || !Object.prototype.hasOwnProperty.call(servers, SERVER)) return undefined;
  return servers[SERVER];
}

function claudeUrl(text) {
  const entry = claudeEntry(parseJsonConfig(text));
  return isPlainObject(entry) && typeof entry.url === "string" ? entry.url : null;
}

const hasClaudeServer = text => claudeEntry(parseJsonConfig(text)) !== undefined;

function setClaudeServer(text, url) {
  const data = parseJsonConfig(text);
  if (!isPlainObject(data.mcpServers)) data.mcpServers = {};
  data.mcpServers[SERVER] = { type: "http", url, timeout: CLAUDE_TIMEOUT_MS };
  return serializeJson(data, text);
}

function removeClaudeServer(text) {
  const data = parseJsonConfig(text);
  if (claudeEntry(data) === undefined) return text;
  delete data.mcpServers[SERVER];
  return serializeJson(data, text);
}

function ensureClaudeTimeout(text) {
  const data = parseJsonConfig(text);
  const entry = claudeEntry(data);
  if (!isPlainObject(entry) || entry.timeout >= CLAUDE_TIMEOUT_MS) return text;
  entry.timeout = CLAUDE_TIMEOUT_MS;
  return serializeJson(data, text);
}

// ---- harness descriptors

function harnesses(home) {
  const codexDir = path.join(home, ".codex");
  const claudeDir = path.join(home, ".claude");
  return {
    codex: {
      tool: "codex",
      label: "Codex",
      bin: "codex",
      fileFirst: true, // the CLI rewrites the whole TOML file
      markers: [codexDir],
      config: path.join(codexDir, "config.toml"),
      skillDir: path.join(codexDir, "skills", SKILL_NAME),
      readUrl: codexUrl,
      has: hasCodexServer,
      set: setCodexServer,
      remove: removeCodexServer,
      ensureTimeout: ensureCodexTimeout,
      addArgs: url => ["mcp", "add", SERVER, "--url", url],
      removeArgs: ["mcp", "remove", SERVER],
    },
    claude: {
      tool: "claude",
      label: "Claude Code",
      bin: "claude",
      markers: [claudeDir, path.join(home, ".claude.json")],
      config: path.join(home, ".claude.json"),
      skillDir: path.join(claudeDir, "skills", SKILL_NAME),
      readUrl: claudeUrl,
      has: hasClaudeServer,
      set: setClaudeServer,
      remove: removeClaudeServer,
      ensureTimeout: ensureClaudeTimeout,
      addArgs: url => ["mcp", "add", "--transport", "http", "--scope", "user", SERVER, url],
      removeArgs: ["mcp", "remove", "--scope", "user", SERVER],
    },
  };
}

// ---- filesystem

async function readText(file) {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

async function anyExists(paths) {
  for (const p of paths) {
    try {
      await fs.promises.access(p);
      return true;
    } catch {}
  }
  return false;
}

// Writes through symlinks (dotfile managers link these configs into a repo)
// and keeps the target's permissions.
async function writeFileAtomic(file, text, newMode = 0o600) {
  let target = file;
  try {
    target = await fs.promises.realpath(file);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  let mode = newMode;
  try {
    mode = (await fs.promises.stat(target)).mode & 0o777;
  } catch {}
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.promises.writeFile(tmp, text, { mode, flag: "wx" });
    await fs.promises.chmod(tmp, mode);
    await fs.promises.rename(tmp, target);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** The user's pre-Router config, kept once and never overwritten. */
async function backupOnce(file) {
  const backup = file + BACKUP_SUFFIX;
  try {
    await fs.promises.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(backup, 0o600);
  } catch (err) {
    if (err.code !== "EEXIST" && err.code !== "ENOENT") throw err;
  }
}

// ---- processes

function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Login shells may print banners first, and `command -v` prints an alias or
// function body rather than a path for those; only a real executable counts.
function lastExecutablePath(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (path.isAbsolute(lines[i]) && isExecutableFile(lines[i])) return lines[i];
  }
  return null;
}

/** Apps launched from Finder get a minimal PATH, so ask a login shell. */
function defaultWhich(name) {
  if (!/^[\w.-]+$/.test(String(name))) return Promise.resolve(null);
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    try {
      const child = childProcess.execFile(
        shell, ["-lc", `command -v ${name}`],
        { timeout: WHICH_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(err ? null : lastExecutablePath(stdout)),
      );
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

function defaultExec(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(
      file, args,
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    // A CLI that stops to ask a question gets EOF instead of hanging until the timeout.
    child.stdin?.end();
  });
}

// execFile errors quote the full command line, and the MCP URL carries the
// endpoint token, so it never reaches the event log.
function redact(text, url) {
  let out = String(text || "");
  if (url) {
    out = out.split(url).join("<mcp-url>");
    const token = url.split("/").pop();
    if (token && token.length >= 16) out = out.split(token).join("<token>");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

// ---- service

class Connectors {
  /**
   * @param {object} opts
   * @param {string} [opts.home]
   * @param {() => string} opts.mcpUrl
   * @param {(file: string, args: string[], opts: object) => Promise<{stdout: string, stderr: string}>} [opts.exec]
   * @param {(name: string) => Promise<string|null>} [opts.which]
   * @param {(event: object) => void} [opts.onEvent]
   */
  constructor({ home = os.homedir(), mcpUrl, exec = defaultExec, which = defaultWhich, onEvent } = {}) {
    this.home = home;
    this.mcpUrl = typeof mcpUrl === "function" ? mcpUrl : () => mcpUrl;
    this.exec = exec;
    this.which = which;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this._harnesses = harnesses(home);
    this._methods = {};
    this._whichCache = new Map();
    this._configCache = new Map();
    this._chain = Promise.resolve();
    this._skill = null;
  }

  async status() {
    const url = this._currentUrl();
    const rows = await Promise.all(TOOLS.map(tool => this._toolStatus(this._harnesses[tool], url)));
    return Object.fromEntries(TOOLS.map((tool, i) => [tool, rows[i]]));
  }

  async connect(tool) {
    const h = this._harness(tool);
    return this._serial(async () => {
      const url = this._currentUrl();
      if (!url) throw userError("Router isn't ready yet. Try again in a moment.", 503, "NOT_READY");
      this._configCache.clear();
      const bin = await this._resolve(h.bin, { fresh: true });
      if (!bin && !(await anyExists(h.markers))) {
        throw userError(`${h.label} isn't installed on this Mac.`, 404, "NOT_FOUND");
      }

      let method = "file";
      if (h.fileFirst) {
        try {
          await this._editConfig(h, text => h.set(text, url));
        } catch (err) {
          if (!bin || err.code === "BAD_CONFIG") throw err;
          // Unwritable here (permissions, a read-only mount): let the CLI try.
          this._emit({ type: "connectors:file-failed", tool: h.tool, message: redact(err.message, url) });
          await this._runCli(h, bin, h.removeArgs, "remove", url, { quiet: true });
          await this._runCli(h, bin, h.addArgs(url), "add", url);
          if ((await this._configuredUrl(h)) !== url) throw err;
          method = "cli";
          await this._editConfig(h, h.ensureTimeout, { backup: false }).catch(() => {});
        }
      } else {
        if (bin) {
          await backupOnce(h.config);
          await this._runCli(h, bin, h.removeArgs, "remove", url, { quiet: true });
          await this._runCli(h, bin, h.addArgs(url), "add", url);
          if ((await this._configuredUrl(h)) === url) method = "cli";
          else this._emit({ type: "connectors:cli-fallback", tool: h.tool });
        }
        // Either way the file gets a pass: the CLIs have no flag for the tool timeout.
        // With a CLI the backup was taken before it ran; one taken now would hold
        // the CLI's edit rather than the user's original.
        await this._editConfig(h, text => (method === "cli" ? h.ensureTimeout(text) : h.set(text, url)),
          { backup: !bin });
      }
      await this._installSkill(h);

      this._methods[h.tool] = method;
      this._emit({ type: "connectors:connected", tool: h.tool, method });
      return this.status();
    });
  }

  async disconnect(tool) {
    const h = this._harness(tool);
    return this._serial(async () => {
      this._configCache.clear();
      if (await this._hasServer(h)) {
        let fileError = null;
        if (h.fileFirst) {
          fileError = await this._editConfig(h, h.remove).then(() => null, err => err);
        }
        if (await this._hasServer(h)) {
          const bin = await this._resolve(h.bin, { fresh: true });
          if (bin) {
            await backupOnce(h.config);
            await this._runCli(h, bin, h.removeArgs, "remove", this._currentUrl());
          }
          if (await this._hasServer(h)) {
            if (fileError) throw fileError;
            await this._editConfig(h, h.remove);
          }
        }
      }
      await this._removeSkill(h);

      delete this._methods[h.tool];
      this._emit({ type: "connectors:disconnected", tool: h.tool });
      return this.status();
    });
  }

  /** The URL of the koinos entry in a harness's config, or null (read from the file). */
  async configuredUrl(tool) {
    return this._configuredUrl(this._harness(tool));
  }

  _harness(tool) {
    if (!TOOLS.includes(tool)) throw userError('Tool must be "codex" or "claude".', 400, "BAD_TOOL");
    return this._harnesses[tool];
  }

  // One mutation at a time: two connects racing would interleave file edits.
  _serial(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  _emit(event) {
    try {
      this.onEvent(event);
    } catch {}
  }

  _currentUrl() {
    try {
      const url = this.mcpUrl();
      return typeof url === "string" && url ? url : null;
    } catch {
      return null;
    }
  }

  async _toolStatus(h, url) {
    const [bin, dirFound, configured] = await Promise.all([
      this._resolve(h.bin),
      anyExists(h.markers),
      this._configuredUrl(h),
    ]);
    const connected = url !== null && configured === url;
    // Which path connected is only known for connects made by this process;
    // otherwise report the one connect would take.
    const method = connected ? this._methods[h.tool] || (bin ? "cli" : "file") : null;
    return { found: Boolean(bin) || dirFound, connected, method };
  }

  // Status polls run often and spawning a login shell is slow, so lookups are
  // cached briefly; connect and disconnect always look again.
  _resolve(name, { fresh = false } = {}) {
    const hit = this._whichCache.get(name);
    if (!fresh && hit && Date.now() - hit.at < WHICH_TTL_MS) return hit.promise;
    const promise = Promise.resolve()
      .then(() => this.which(name))
      .then(
        p => (typeof p === "string" && path.isAbsolute(p) ? p : null),
        (err) => {
          this._emit({ type: "connectors:which-failed", name, message: redact(err?.message) });
          return null;
        },
      );
    this._whichCache.set(name, { at: Date.now(), promise });
    return promise;
  }

  // ~/.claude.json can grow to megabytes; reparse only when the file changed.
  async _configuredUrl(h) {
    let st;
    try {
      st = await fs.promises.stat(h.config);
    } catch {
      return null;
    }
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const hit = this._configCache.get(h.config);
    if (hit && hit.key === key) return hit.url;
    let url = null;
    try {
      const text = await readText(h.config);
      url = text === null ? null : h.readUrl(text);
    } catch (err) {
      this._emit({ type: "connectors:config-unreadable", tool: h.tool, message: redact(err.message) });
    }
    this._configCache.set(h.config, { key, url });
    return url;
  }

  async _hasServer(h) {
    try {
      const text = await readText(h.config);
      return text !== null && h.has(text);
    } catch (err) {
      this._emit({ type: "connectors:config-unreadable", tool: h.tool, message: redact(err.message) });
      return false;
    }
  }

  async _editConfig(h, edit, { backup = true } = {}) {
    const text = (await readText(h.config)) ?? "";
    let next;
    try {
      next = edit(text);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      const shown = "~" + path.sep + path.relative(this.home, h.config);
      throw userError(`${shown} isn't valid JSON, so Router left it unchanged.`, 409, "BAD_CONFIG");
    }
    this._configCache.clear();
    if (next === text) return false;
    if (backup) await backupOnce(h.config);
    await writeFileAtomic(h.config, next);
    return true;
  }

  _childEnv(bin) {
    const env = { ...process.env, HOME: this.home };
    // Keep the CLI on the same files status reads.
    delete env.CODEX_HOME;
    delete env.CLAUDE_CONFIG_DIR;
    // npm-installed CLIs start with `#!/usr/bin/env node`; node usually sits
    // next to them, and a Finder-launched app's PATH would not find it.
    env.PATH = [path.dirname(bin), env.PATH].filter(Boolean).join(path.delimiter);
    return env;
  }

  async _runCli(h, bin, args, step, url, { quiet = false } = {}) {
    try {
      await this.exec(bin, args, { env: this._childEnv(bin), timeout: EXEC_TIMEOUT_MS });
      this._configCache.clear();
      return true;
    } catch (err) {
      this._configCache.clear();
      if (!quiet) {
        const message = redact([err?.message, err?.stderr].filter(Boolean).join(" "), url);
        this._emit({ type: "connectors:cli-failed", tool: h.tool, step, message });
      }
      return false;
    }
  }

  async _skillText() {
    if (this._skill === null) this._skill = await fs.promises.readFile(SKILL_SOURCE, "utf8");
    return this._skill;
  }

  // A SKILL.md without our marker is the user's own; it is never overwritten.
  async _installSkill(h) {
    const file = path.join(h.skillDir, "SKILL.md");
    try {
      const existing = await readText(file);
      if (existing !== null && !existing.includes(SKILL_MARKER)) {
        this._emit({ type: "connectors:skill-skipped", tool: h.tool });
        return false;
      }
      const content = await this._skillText();
      if (existing !== content) await writeFileAtomic(file, content, 0o644);
      return true;
    } catch (err) {
      // The server entry is what matters; a missing skill only means fewer delegations.
      this._emit({ type: "connectors:skill-failed", tool: h.tool, message: redact(err.message) });
      return false;
    }
  }

  async _removeSkill(h) {
    const file = path.join(h.skillDir, "SKILL.md");
    try {
      const existing = await readText(file);
      if (existing === null || !existing.includes(SKILL_MARKER)) return false;
      await fs.promises.rm(file, { force: true });
      // Anything the user added to the folder stays; Finder litter does not.
      const rest = (await fs.promises.readdir(h.skillDir)).filter(name => name !== ".DS_Store");
      if (rest.length === 0) await fs.promises.rm(h.skillDir, { recursive: true, force: true });
      return true;
    } catch (err) {
      this._emit({ type: "connectors:skill-failed", tool: h.tool, message: redact(err.message) });
      return false;
    }
  }
}

module.exports = {
  Connectors,
  SKILL_MARKER,
  SKILL_SOURCE,
  BACKUP_SUFFIX,
  CODEX_TOOL_TIMEOUT_SEC,
  CLAUDE_TIMEOUT_MS,
  defaultWhich,
  defaultExec,
  toml: { codexUrl, setCodexServer, removeCodexServer, ensureCodexTimeout },
  json: { claudeUrl, setClaudeServer, removeClaudeServer, ensureClaudeTimeout },
};
