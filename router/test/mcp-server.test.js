"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");

const { McpServer, PARSE_ERROR, PROTOCOL_VERSIONS, harnessFor } = require("../lib/mcp-server");

/*
 * The MCP server is what Codex and Claude Code talk to. These drive it over
 * real HTTP (localhost only) the way the gateway extension will: read the
 * body, JSON.parse it, hand PARSE_ERROR over when that fails.
 */

const ECHO_SCHEMA = {
  type: "object",
  required: ["task"],
  properties: { task: { type: "string" }, text: { type: "string" } },
};

async function start(t, opts = {}) {
  const calls = [];
  const events = [];
  const tools = opts.tools || [
    {
      name: "echo",
      description: "Echo the task back",
      inputSchema: ECHO_SCHEMA,
      handler: async (args, ctx) => {
        calls.push({ args, ctx });
        return { text: `echo: ${args.task}` };
      },
    },
    {
      name: "boom",
      description: "Always throws",
      inputSchema: { type: "object" },
      handler: async () => {
        throw new Error("NETWORK_BUSY: no providers right now");
      },
    },
    {
      name: "soft-fail",
      description: "Returns a tool error",
      inputSchema: { type: "object" },
      handler: async () => ({ text: "OUT_OF_KAI: balance is 0", isError: true }),
    },
  ];
  const mcp = new McpServer({
    version: "1.2.3",
    instructions: "Use delegate for small text jobs.",
    tools,
    onEvent: (e) => events.push(e),
    sessionStore: opts.sessionStore,
  });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      if (raw.length) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = PARSE_ERROR;
        }
      }
      try {
        await mcp.handle(req, res, body);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err && err.message));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const url = `http://127.0.0.1:${server.address().port}/mcp/token`;
  return { url, mcp, calls, events };
}

async function post(url, payload, { session, raw } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(url, { method: "POST", headers, body: raw ?? JSON.stringify(payload) });
  const text = await res.text();
  return { res, text, json: text ? JSON.parse(text) : undefined };
}

function rpc(id, method, params) {
  const msg = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg.params = params;
  return msg;
}

async function initialize(url, clientName, protocolVersion = "2025-06-18") {
  const out = await post(
    url,
    rpc(1, "initialize", { protocolVersion, capabilities: {}, clientInfo: { name: clientName, version: "1.0.0" } })
  );
  return { ...out, session: out.res.headers.get("mcp-session-id") };
}

async function callTool(url, name, args, session, id = 7) {
  return post(url, rpc(id, "tools/call", { name, arguments: args }), { session });
}

test("initialize negotiates the client's version and opens a session", async (t) => {
  const { url } = await start(t);
  const { res, json, session } = await initialize(url, "claude-code", "2025-03-26");
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/json/);
  assert.match(session, /^[0-9a-f]{32}$/);
  assert.deepStrictEqual(json, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "koinos", version: "1.2.3" },
      instructions: "Use delegate for small text jobs.",
    },
  });

  const second = await initialize(url, "claude-code", "2025-03-26");
  assert.notStrictEqual(second.session, session, "every initialize gets a fresh session id");
});

test("initialize accepts every supported version and falls back to the latest", async (t) => {
  const { url } = await start(t);
  for (const v of PROTOCOL_VERSIONS) {
    const { json } = await initialize(url, "x", v);
    assert.strictEqual(json.result.protocolVersion, v);
  }
  const unknown = await initialize(url, "x", "1999-01-01");
  assert.strictEqual(unknown.json.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  // The real Claude Code CLI (2.1.x) opens with 2025-11-25 and must get it back.
  assert.strictEqual(PROTOCOL_VERSIONS[0], "2025-11-25");

  const bare = await post(url, rpc(2, "initialize", {}));
  assert.strictEqual(bare.json.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.ok(bare.res.headers.get("mcp-session-id"));
});

test("notifications and client responses get 202 with an empty body", async (t) => {
  const { url } = await start(t);
  const { session } = await initialize(url, "codex-mcp-client");

  const note = await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, { session });
  assert.strictEqual(note.res.status, 202);
  assert.strictEqual(note.text, "");

  const unknownNote = await post(url, { jsonrpc: "2.0", method: "notifications/whatever", params: {} });
  assert.strictEqual(unknownNote.res.status, 202);
  assert.strictEqual(unknownNote.text, "");

  const reply = await post(url, { jsonrpc: "2.0", id: 99, result: {} });
  assert.strictEqual(reply.res.status, 202);
  assert.strictEqual(reply.text, "");
});

test("tools/list describes every registered tool", async (t) => {
  const { url } = await start(t);
  const { json } = await post(url, rpc("list-1", "tools/list", {}));
  assert.strictEqual(json.id, "list-1", "string ids round-trip");
  assert.deepStrictEqual(
    json.result.tools.map((tool) => tool.name),
    ["echo", "boom", "soft-fail"]
  );
  const echo = json.result.tools[0];
  assert.deepStrictEqual(echo, { name: "echo", description: "Echo the task back", inputSchema: ECHO_SCHEMA });
  assert.ok(!("handler" in echo));
});

test("ping returns an empty result", async (t) => {
  const { url } = await start(t);
  const { res, json } = await post(url, rpc(3, "ping"));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(json, { jsonrpc: "2.0", id: 3, result: {} });
});

test("tools/call runs the handler with args and the session's harness", async (t) => {
  const { url, calls, events } = await start(t);
  const { session } = await initialize(url, "codex-mcp-client");
  const { res, json } = await callTool(url, "echo", { task: "summarize", text: "log" }, session);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(json, {
    jsonrpc: "2.0",
    id: 7,
    result: { content: [{ type: "text", text: "echo: summarize" }], isError: false },
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args, { task: "summarize", text: "log" });
  assert.deepStrictEqual({ ...calls[0].ctx, signal: undefined }, { harness: "codex", sessionId: session, signal: undefined });
  assert.ok(calls[0].ctx.signal instanceof AbortSignal);
  assert.strictEqual(calls[0].ctx.signal.aborted, false);
  assert.ok(events.some((e) => e.type === "mcp-server:tool-call" && e.tool === "echo" && e.ok === true));
});

test("a handler that throws becomes an isError result with only the message", async (t) => {
  const { url } = await start(t);
  const { res, json } = await callTool(url, "boom", {});
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(json.result, {
    content: [{ type: "text", text: "NETWORK_BUSY: no providers right now" }],
    isError: true,
  });
  assert.doesNotMatch(JSON.stringify(json), /at .*mcp-server|\.js:\d+/, "no stack trace leaks to the agent");
});

test("a handler can report a tool error itself", async (t) => {
  const { url } = await start(t);
  const { json } = await callTool(url, "soft-fail", {});
  assert.deepStrictEqual(json.result, { content: [{ type: "text", text: "OUT_OF_KAI: balance is 0" }], isError: true });
});

test("unknown tool is an invalid-params protocol error", async (t) => {
  const { url } = await start(t);
  const { res, json } = await callTool(url, "nope", {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(json.id, 7);
  assert.strictEqual(json.error.code, -32602);
  assert.match(json.error.message, /Unknown tool: nope/);
  assert.ok(!("result" in json));

  const noName = await post(url, rpc(8, "tools/call", { arguments: {} }));
  assert.strictEqual(noName.json.error.code, -32602);

  const badArgs = await post(url, rpc(9, "tools/call", { name: "echo", arguments: ["task"] }));
  assert.strictEqual(badArgs.json.error.code, -32602);
});

test("a missing required argument is a tool error, and the handler never runs", async (t) => {
  const { url, calls } = await start(t);
  const { json } = await callTool(url, "echo", { text: "only text" });
  assert.deepStrictEqual(json.result, { content: [{ type: "text", text: "Missing required argument: task" }], isError: true });

  const nullTask = await callTool(url, "echo", { task: null });
  assert.strictEqual(nullTask.json.result.isError, true);

  const noArgs = await post(url, rpc(10, "tools/call", { name: "echo" }));
  assert.match(noArgs.json.result.content[0].text, /Missing required argument: task/);
  assert.strictEqual(calls.length, 0);
});

test("batch requests answer each request in order and skip notifications", async (t) => {
  const { url } = await start(t);
  const { res, json } = await post(url, [
    rpc(1, "ping"),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    rpc("b", "tools/list"),
    { jsonrpc: "1.0", id: 4, method: "ping" },
    rpc(5, "tools/call", { name: "echo", arguments: { task: "t" } }),
    rpc(6, "no/such/method"),
  ]);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(json));
  assert.deepStrictEqual(
    json.map((r) => r.id),
    [1, "b", 4, 5, 6]
  );
  assert.deepStrictEqual(json[0].result, {});
  assert.strictEqual(json[1].result.tools.length, 3);
  assert.strictEqual(json[2].error.code, -32600);
  assert.strictEqual(json[3].result.content[0].text, "echo: t");
  assert.strictEqual(json[4].error.code, -32601);

  const onlyNotes = await post(url, [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
  ]);
  assert.strictEqual(onlyNotes.res.status, 202);
  assert.strictEqual(onlyNotes.text, "");
});

test("an initialize inside a batch sets the session for the calls after it", async (t) => {
  const { url, calls } = await start(t);
  const { res, json } = await post(url, [
    rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } }),
    rpc(2, "tools/call", { name: "echo", arguments: { task: "x" } }),
  ]);
  const session = res.headers.get("mcp-session-id");
  assert.match(session, /^[0-9a-f]{32}$/);
  assert.strictEqual(json.length, 2);
  assert.deepStrictEqual({ ...calls[0].ctx, signal: undefined }, { harness: "claude", sessionId: session, signal: undefined });
});

test("malformed payloads get JSON-RPC errors", async (t) => {
  const { url } = await start(t);

  const parse = await post(url, null, { raw: "{not json" });
  assert.strictEqual(parse.res.status, 400);
  assert.deepStrictEqual(parse.json, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });

  const empty = await post(url, []);
  assert.strictEqual(empty.res.status, 400);
  assert.strictEqual(empty.json.error.code, -32600);
  assert.ok(!Array.isArray(empty.json));

  const scalar = await post(url, 42);
  assert.strictEqual(scalar.json.error.code, -32600);

  const noBody = await post(url, null, { raw: "" });
  assert.strictEqual(noBody.json.error.code, -32600);

  const wrongVersion = await post(url, { jsonrpc: "1.0", id: 5, method: "ping" });
  assert.strictEqual(wrongVersion.res.status, 200);
  assert.deepStrictEqual(wrongVersion.json, {
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32600, message: "Invalid Request" },
  });

  const badId = await post(url, { jsonrpc: "2.0", id: { x: 1 }, method: "ping" });
  assert.strictEqual(badId.json.id, null);
  assert.strictEqual(badId.json.error.code, -32600);

  const methodNotString = await post(url, { jsonrpc: "2.0", id: 6, method: 1 });
  assert.strictEqual(methodNotString.json.error.code, -32600);

  const batchOfJunk = await post(url, [1]);
  assert.deepStrictEqual(batchOfJunk.json, [{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }]);
});

test("unknown methods are -32601", async (t) => {
  const { url } = await start(t);
  const { res, json } = await post(url, rpc(11, "resources/list", {}));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(json.id, 11);
  assert.strictEqual(json.error.code, -32601);
  assert.match(json.error.message, /resources\/list/);
});

test("GET is 405 with an Allow header (no SSE stream)", async (t) => {
  const { url } = await start(t);
  const res = await fetch(url, { headers: { accept: "text/event-stream" } });
  assert.strictEqual(res.status, 405);
  assert.strictEqual(res.headers.get("allow"), "POST, DELETE");
  await res.text();
});

test("DELETE drops the session; later calls fall back to harness other", async (t) => {
  const { url, mcp, calls } = await start(t);
  const { session } = await initialize(url, "claude-code");
  assert.strictEqual(mcp.sessions.size, 1);

  const del = await fetch(url, { method: "DELETE", headers: { "mcp-session-id": session } });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(await del.text(), "");
  assert.strictEqual(mcp.sessions.size, 0);

  const { json } = await callTool(url, "echo", { task: "after" }, session);
  assert.strictEqual(json.result.isError, false, "an unknown session is tolerated, not rejected");
  assert.strictEqual(calls[0].ctx.harness, "other");

  const bare = await fetch(url, { method: "DELETE" });
  assert.strictEqual(bare.status, 200);
  await bare.text();
});

test("clientInfo.name maps each session to its harness", async (t) => {
  const { url, calls } = await start(t);
  const codex = await initialize(url, "codex-mcp-client");
  const claude = await initialize(url, "claude-code");
  const other = await initialize(url, "cursor");

  await callTool(url, "echo", { task: "1" }, codex.session);
  await callTool(url, "echo", { task: "2" }, claude.session);
  await callTool(url, "echo", { task: "3" }, other.session);
  await callTool(url, "echo", { task: "4" }); // no session header at all
  await callTool(url, "echo", { task: "5" }, "f".repeat(32)); // a session we never issued

  assert.deepStrictEqual(
    calls.map((c) => c.ctx.harness),
    ["codex", "claude", "other", "other", "other"]
  );
  assert.strictEqual(calls[3].ctx.sessionId, null);
});

test("harnessFor matches loosely and case-insensitively", () => {
  assert.strictEqual(harnessFor("codex-mcp-client"), "codex");
  assert.strictEqual(harnessFor("Codex Desktop"), "codex");
  assert.strictEqual(harnessFor("claude-code"), "claude");
  assert.strictEqual(harnessFor("Claude Desktop"), "claude");
  assert.strictEqual(harnessFor("cursor"), "other");
  assert.strictEqual(harnessFor(undefined), "other");
});

test("the constructor rejects tools without a handler", () => {
  assert.throws(() => new McpServer({ version: "1", tools: [{ name: "x" }] }), TypeError);
  assert.strictEqual(McpServer.PARSE_ERROR, PARSE_ERROR);
  assert.strictEqual(typeof PARSE_ERROR, "symbol");
});

test("sessions are capped so a chatty client cannot grow memory without bound", () => {
  const mcp = new McpServer({ version: "1", tools: [] });
  for (let i = 0; i < 1005; i++) mcp._remember(`s${i}`, { harness: "other", client: "" });
  assert.strictEqual(mcp.sessions.size, 1000);
  assert.ok(!mcp.sessions.has("s0"), "the oldest session is evicted first");
  assert.ok(mcp.sessions.has("s1004"));
});

test("a throwing onEvent never breaks the protocol", async (t) => {
  const mcp = new McpServer({
    version: "1",
    tools: [{ name: "ok", inputSchema: { type: "object" }, handler: async () => ({ text: "fine" }) }],
    onEvent: () => {
      throw new Error("logger down");
    },
  });
  const res = fakeRes();
  await mcp.handle({ method: "POST", headers: {} }, res, rpc(1, "tools/call", { name: "ok" }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(JSON.parse(res.body).result.content[0].text, "fine");
});

function fakeRes() {
  return {
    headersSent: false,
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(data) {
      this.body = data === undefined ? "" : String(data);
    },
  };
}

// ---- cancellation and sessions that outlive a restart

function waitingTool(seen) {
  return {
    name: "wait",
    description: "Waits until cancelled",
    inputSchema: { type: "object" },
    handler: (args, ctx) =>
      new Promise((resolve) => {
        seen.push(ctx.signal);
        ctx.signal.addEventListener("abort", () => resolve({ text: "CANCELLED: stopped", isError: true }), { once: true });
        setTimeout(() => resolve({ text: "finished" }), 2000).unref();
      }),
  };
}

test("notifications/cancelled aborts the matching tools/call of that session only", async (t) => {
  const seen = [];
  const { url, events } = await start(t, { tools: [waitingTool(seen)] });
  const a = await initialize(url, "codex-mcp-client");
  const b = await initialize(url, "claude-code");
  const callA = post(url, rpc(7, "tools/call", { name: "wait", arguments: {} }), { session: a.session });
  const callB = post(url, rpc(7, "tools/call", { name: "wait", arguments: {} }), { session: b.session });
  while (seen.length < 2) await new Promise((r) => setTimeout(r, 5));

  const note = await post(url, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "user pressed Esc" } }, { session: a.session });
  assert.strictEqual(note.res.status, 202);
  const outA = await callA;
  assert.strictEqual(outA.json.result.isError, true);
  assert.strictEqual(seen.filter((s) => s.aborted).length, 1, "only the cancelled session's call stopped");
  assert.ok(events.some((e) => e.type === "mcp-server:cancelled" && e.harness === "codex"));
  // Unknown ids and malformed cancels are ignored.
  await post(url, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } }, { session: b.session });
  await post(url, { jsonrpc: "2.0", method: "notifications/cancelled", params: {} }, { session: b.session });
  const outB = await callB;
  assert.strictEqual(outB.json.result.content[0].text, "finished");
});

test("a client that hangs up mid-call cancels the tool's work", async (t) => {
  const seen = [];
  const { url } = await start(t, { tools: [waitingTool(seen)] });
  const controller = new AbortController();
  const pending = fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rpc(3, "tools/call", { name: "wait", arguments: {} })),
    signal: controller.signal,
  }).catch((e) => e);
  while (seen.length < 1) await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await pending;
  const until = Date.now() + 1000;
  while (!seen[0].aborted && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(seen[0].aborted, true);
});

test("a finished call's signal is never aborted by the connection closing afterwards", async (t) => {
  const { url, calls } = await start(t);
  const { json } = await callTool(url, "echo", { task: "x" });
  assert.strictEqual(json.result.isError, false);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(calls[0].ctx.signal.aborted, false);
});

test("sessions persist through the session store, so a restart keeps the harness", async (t) => {
  let saved = [];
  const store = { load: () => saved, save: (entries) => (saved = entries) };
  const first = await start(t, { sessionStore: store });
  const { session } = await initialize(first.url, "codex-mcp-client");
  assert.deepStrictEqual(saved, [[session, "codex"]]);

  // "Router restarts": a new server with the same store; Codex keeps its id.
  const second = await start(t, { sessionStore: store });
  await callTool(second.url, "echo", { task: "after restart" }, session);
  assert.strictEqual(second.calls[0].ctx.harness, "codex");

  await fetch(second.url, { method: "DELETE", headers: { "mcp-session-id": session } }).then((r) => r.text());
  assert.deepStrictEqual(saved, []);

  // A corrupt store is ignored, never fatal.
  const bad = await start(t, { sessionStore: { load: () => [["nope", "codex"], "x", null, ["a".repeat(32), "hacker"]], save: () => { throw new Error("disk full"); } } });
  assert.strictEqual(bad.mcp.sessions.get("a".repeat(32)).harness, "other");
  assert.strictEqual(bad.mcp.sessions.size, 1);
  const init = await initialize(bad.url, "claude-code");
  assert.strictEqual(init.res.status, 200);
  assert.ok(bad.events.some((e) => e.type === "mcp-server:sessions-unsaved"));
});
