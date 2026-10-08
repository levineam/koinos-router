"use strict";

/*
 * /core/router/* — a thin HTTP layer over RouterService, mounted as a gateway
 * extension. The gateway has already applied its control-plane guards (local
 * Host, same-site Origin, optional KAI_CORE_TOKEN) before we see a request.
 * Responses are { ok: true, ... } or { ok: false, error: "<sentence>" }.
 */

const MAX_BODY_BYTES = 64 * 1024; // settings patches and toggles are tiny

function sendJson(res, status, body) {
  if (res.headersSent) return res.end();
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;
  // Drain an oversized body instead of throwing mid-stream, which would tear
  // down the socket before the 413 reaches the client.
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes <= limit) chunks.push(chunk);
  }
  if (bytes > limit) throw httpError(413, "That request is too large.");
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw httpError(400, "The request body isn't valid JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "Send a JSON object.");
  return body;
}

function enabledFlag(body) {
  if (typeof body.enabled !== "boolean") throw httpError(400, "Send enabled as true or false.");
  return body.enabled;
}

function sentence(message) {
  const s = String(message || "").trim() || "Something went wrong.";
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

function createRouterRoutes({ service, onEvent = () => {} }) {
  const routes = {
    "GET /core/router/status": () => service.status(),
    "POST /core/router/share": (body) => service.setShare(enabledFlag(body)),
    "POST /core/router/use": (body) => service.setUse(enabledFlag(body)),
    "GET /core/router/activity": () => service.activity(),
    "GET /core/router/settings": () => service.getSettings(),
    "POST /core/router/settings": (body) => service.updateSettings(body),
    "GET /core/router/connections": () => service.connections(),
    "POST /core/router/connect": (body) => service.connect(body.tool),
    "POST /core/router/disconnect": (body) => service.disconnect(body.tool),
    "POST /core/router/onboarding/complete": () => service.completeOnboarding(),
  };
  const paths = new Set(Object.keys(routes).map((k) => k.slice(k.indexOf(" ") + 1)));

  return async function routerRoutes(req, res, { path }) {
    if (path !== "/core/router" && !path.startsWith("/core/router/")) return false;
    const handler = routes[`${req.method} ${path}`];
    if (!handler) {
      if (paths.has(path)) sendJson(res, 405, { ok: false, error: `${req.method} isn't supported here.` });
      else sendJson(res, 404, { ok: false, error: "Not found." });
      return true;
    }
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      const out = await handler(body);
      sendJson(res, 200, { ok: true, ...out });
    } catch (e) {
      const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
      if (status >= 500) onEvent({ type: "router:route-error", message: `${req.method} ${path}: ${e?.message}` });
      sendJson(res, status, { ok: false, error: sentence(e?.message) });
    }
    return true;
  };
}

module.exports = { createRouterRoutes, sendJson, MAX_BODY_BYTES };
