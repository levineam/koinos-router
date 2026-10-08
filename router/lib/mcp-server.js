"use strict";

const crypto = require("crypto");

/*
 * MCP server (Streamable HTTP, JSON responses only) for Koinos Router.
 *
 * Codex and Claude Code reach us at POST /mcp/<token>. The gateway extension
 * that mounts this owns the token check, the Origin check and reading the
 * body; handle() only speaks the protocol. Scope is tools-only: initialize,
 * ping, tools/list, tools/call. We never open an SSE stream — every request
 * we serve finishes in one JSON response, which both harnesses accept.
 *
 * Sessions exist only to learn WHICH harness is calling (clientInfo.name at
 * initialize), so the ledger can say "Codex · 1:32 PM". They are not a
 * security boundary — the path token is — and the two clients disagree on
 * session handling, so an unknown or missing Mcp-Session-Id is served as
 * harness "other" instead of being rejected with 404. Both harnesses keep
 * their session id across a Router restart, so the session → harness map
 * can be persisted through an optional sessionStore.
 *
 * A tools/call is cancelled (ctx.signal aborts) when the client sends
 * notifications/cancelled for it, or drops the HTTP request before we answer:
 * a delegation nobody will read must stop spending.
 */

// Newest first. Claude Code 2.1.x opens with 2025-11-25 (observed against the real CLI).
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];
const MAX_SESSIONS = 1000; // a session per harness launch; cap so a chatty client can't grow memory forever
const MAX_SAVED_SESSIONS = 200; // newest sessions kept across restarts
const MAX_ECHO = 100; // longest client-supplied string we repeat back in an error

// The gateway passes this as `body` when the request body was not valid JSON.
const PARSE_ERROR = Symbol("mcp-server.parse-error");

const PARSE = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL = -32603;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function harnessFor(clientName) {
  const name = String(clientName || "");
  if (/codex/i.test(name)) return "codex";
  if (/claude/i.test(name)) return "claude";
  return "other";
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isValidId(id) {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

function clip(s) {
  const str = String(s);
  return str.length > MAX_ECHO ? `${str.slice(0, MAX_ECHO)}…` : str;
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(text, isError) {
  return { content: [{ type: "text", text: String(text) }], isError: !!isError };
}

// Only the message: a stack would leak local paths to the calling agent.
function errorText(err) {
  if (err && typeof err.message === "string" && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "The tool failed";
}

/** What a single JSON-RPC message is, and the id to answer an invalid one with. */
function classify(msg) {
  const id = isPlainObject(msg) && isValidId(msg.id) ? msg.id : null;
  if (!isPlainObject(msg) || msg.jsonrpc !== "2.0") return { kind: "invalid", id };
  const hasId = Object.hasOwn(msg, "id");
  if (typeof msg.method === "string") {
    if (!hasId) return { kind: "notification" };
    if (!isValidId(msg.id)) return { kind: "invalid", id: null };
    return { kind: "request", id: msg.id };
  }
  if (hasId && (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))) return { kind: "response" };
  return { kind: "invalid", id };
}

function missingRequired(schema, args) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return required.filter((key) => typeof key === "string" && (args[key] === undefined || args[key] === null));
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return res.end();
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sendEmpty(res, status, headers = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { ...headers, "content-length": 0 });
  res.end();
}

class McpServer {
  /**
   * @param {object} opts
   * @param {string} [opts.name]
   * @param {string} opts.version
   * @param {string} [opts.instructions]
   * @param {Array<{name: string, description?: string, inputSchema?: object,
   *   handler: (args: object, ctx: {harness: string, sessionId: string|null}) =>
   *   Promise<{text: string, isError?: boolean}>}>} opts.tools
   * @param {(event: object) => void} [opts.onEvent]
   */
  constructor({ name = "koinos", version, instructions, tools = [], onEvent, sessionStore = null } = {}) {
    this.name = name;
    this.version = version || "0.0.0";
    this.instructions = instructions;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.tools = new Map();
    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string" || typeof tool.handler !== "function") {
        throw new TypeError("Each MCP tool needs a name and a handler function");
      }
      this.tools.set(tool.name, tool);
    }
    this.sessions = new Map(); // sessionId → { harness, client }
    this.inflight = new Map(); // "<sessionId>:<request id>" → AbortController
    this.sessionStore = sessionStore && typeof sessionStore.save === "function" ? sessionStore : null;
    this._loadSessions(sessionStore);
  }

  async handle(req, res, body) {
    const method = String(req.method || "").toUpperCase();
    if (method === "DELETE") {
      const sessionId = this._sessionIdOf(req);
      if (sessionId && this.sessions.delete(sessionId)) {
        this._saveSessions();
        this._emit({ type: "mcp-server:session-closed" });
      }
      return sendEmpty(res, 200);
    }
    if (method !== "POST") {
      return sendJson(res, 405, rpcError(null, -32000, "Method not allowed"), { Allow: "POST, DELETE" });
    }

    if (body === PARSE_ERROR) return sendJson(res, 400, rpcError(null, PARSE, "Parse error"));
    if (Array.isArray(body) ? body.length === 0 : !isPlainObject(body)) {
      return sendJson(res, 400, rpcError(null, INVALID_REQUEST, "Invalid Request"));
    }

    const sessionId = this._sessionIdOf(req);
    // The client hanging up before we answer cancels whatever this request
    // started. (res "close" also fires after a normal end; writableEnded
    // tells the two apart.)
    const controllers = new Set();
    const exchange = { sessionId, headers: {}, controllers };
    const onClose = () => {
      if (res.writableEnded) return;
      for (const c of controllers) c.abort();
    };
    if (typeof res.on === "function") res.on("close", onClose);
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    try {
      // Sequential on purpose: an initialize earlier in a batch must be seen by
      // the calls after it, and network delegations are serialized anyway.
      for (const msg of messages) {
        const response = await this._process(msg, exchange);
        if (response) responses.push(response);
      }
    } finally {
      if (typeof res.off === "function") res.off("close", onClose);
    }

    if (!responses.length) return sendEmpty(res, 202, exchange.headers);
    return sendJson(res, 200, Array.isArray(body) ? responses : responses[0], exchange.headers);
  }

  /** One JSON-RPC message → its response, or null when none is owed. */
  async _process(msg, exchange) {
    const { kind, id } = classify(msg);
    if (kind === "invalid") return rpcError(id, INVALID_REQUEST, "Invalid Request");
    if (kind === "notification" && msg.method === "notifications/cancelled") {
      this._cancel(exchange.sessionId, msg.params?.requestId);
      return null;
    }
    // Other client notifications (initialized) and replies to requests we
    // never send need no action from a tools-only server.
    if (kind !== "request") return null;
    try {
      return rpcResult(id, await this._dispatch(msg.method, msg.params, exchange, id));
    } catch (err) {
      if (err instanceof RpcError) return rpcError(id, err.code, err.message);
      this._emit({ type: "mcp-server:internal-error", method: clip(msg.method), message: errorText(err) });
      return rpcError(id, INTERNAL, "Internal error");
    }
  }

  async _dispatch(method, params, exchange, id) {
    switch (method) {
      case "initialize":
        return this._initialize(params, exchange);
      case "ping":
        return {};
      case "tools/list":
        return { tools: [...this.tools.values()].map(describeTool) };
      case "tools/call":
        return this._callTool(params, exchange, id);
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${clip(method)}`);
    }
  }

  _initialize(params, exchange) {
    if (params !== undefined && !isPlainObject(params)) {
      throw new RpcError(INVALID_PARAMS, "initialize params must be an object");
    }
    const requested = params?.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL;
    const client = typeof params?.clientInfo?.name === "string" ? clip(params.clientInfo.name) : "";
    const harness = harnessFor(client);

    const sessionId = crypto.randomBytes(16).toString("hex");
    this._remember(sessionId, { harness, client });
    exchange.headers["Mcp-Session-Id"] = sessionId;
    exchange.sessionId = sessionId;
    this._emit({ type: "mcp-server:initialized", harness, client, protocolVersion });

    const result = {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.name, version: this.version },
    };
    if (this.instructions) result.instructions = this.instructions;
    return result;
  }

  async _callTool(params, exchange, id) {
    if (!isPlainObject(params) || typeof params.name !== "string") {
      throw new RpcError(INVALID_PARAMS, "tools/call needs params.name");
    }
    const tool = this.tools.get(params.name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${clip(params.name)}`);
    const args = params.arguments ?? {};
    if (!isPlainObject(args)) throw new RpcError(INVALID_PARAMS, "Tool arguments must be an object");

    const controller = new AbortController();
    const ctx = { harness: this._harnessOf(exchange.sessionId), sessionId: exchange.sessionId, signal: controller.signal };
    // A tool-level error (not a protocol error) so the agent reads the message
    // and can retry with the argument, instead of the client hiding it.
    const missing = missingRequired(tool.inputSchema, args);
    if (missing.length) {
      return toolResult(`Missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`, true);
    }

    const started = Date.now();
    const report = (ok, extra) => {
      const ms = Date.now() - started;
      this._emit({ type: "mcp-server:tool-call", tool: tool.name, harness: ctx.harness, ok, ms, ...extra });
    };
    const key = this._requestKey(exchange.sessionId, id);
    this.inflight.set(key, controller);
    exchange.controllers?.add(controller);
    try {
      const out = await tool.handler(args, ctx);
      const text = typeof out === "string" ? out : out?.text ?? "";
      const isError = typeof out === "object" && out !== null && !!out.isError;
      report(!isError, controller.signal.aborted ? { cancelled: true } : undefined);
      return toolResult(text, isError);
    } catch (err) {
      const message = errorText(err);
      report(false, { message });
      return toolResult(message, true);
    } finally {
      if (this.inflight.get(key) === controller) this.inflight.delete(key);
      exchange.controllers?.delete(controller);
    }
  }

  _requestKey(sessionId, id) {
    return `${sessionId || ""}:${typeof id}:${String(id)}`;
  }

  _cancel(sessionId, requestId) {
    if (!isValidId(requestId)) return;
    const controller = this.inflight.get(this._requestKey(sessionId, requestId));
    if (!controller) return;
    controller.abort();
    this._emit({ type: "mcp-server:cancelled", harness: this._harnessOf(sessionId) });
  }

  _sessionIdOf(req) {
    const raw = req.headers?.["mcp-session-id"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && value ? value : null;
  }

  _harnessOf(sessionId) {
    return (sessionId && this.sessions.get(sessionId)?.harness) || "other";
  }

  _remember(sessionId, info) {
    this.sessions.set(sessionId, info);
    // Maps iterate in insertion order, so the first key is the oldest session.
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    this._saveSessions();
  }

  _loadSessions(store) {
    if (!store || typeof store.load !== "function") return;
    let entries;
    try {
      entries = store.load();
    } catch (err) {
      this._emit({ type: "mcp-server:sessions-unreadable", message: errorText(err) });
      return;
    }
    if (!Array.isArray(entries)) return;
    for (const entry of entries.slice(-MAX_SAVED_SESSIONS)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !/^[0-9a-f]{32}$/.test(entry[0])) continue;
      const harness = ["codex", "claude", "other"].includes(entry[1]) ? entry[1] : "other";
      this.sessions.set(entry[0], { harness, client: "" });
    }
  }

  _saveSessions() {
    if (!this.sessionStore) return;
    const entries = [...this.sessions].slice(-MAX_SAVED_SESSIONS).map(([id, info]) => [id, info.harness]);
    try {
      this.sessionStore.save(entries);
    } catch (err) {
      this._emit({ type: "mcp-server:sessions-unsaved", message: errorText(err) });
    }
  }

  _emit(event) {
    try {
      this.onEvent(event);
    } catch {
      // A broken logger must never break the protocol.
    }
  }
}

function describeTool(tool) {
  return {
    name: tool.name,
    description: tool.description || "",
    inputSchema: tool.inputSchema || { type: "object" },
  };
}

McpServer.PARSE_ERROR = PARSE_ERROR;

module.exports = { McpServer, PARSE_ERROR, PROTOCOL_VERSIONS, harnessFor };
