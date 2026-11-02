import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createJiti } from "jiti";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const root = process.env.PI_CODING_AGENT_DIR;
process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "remote", name: "Debian" }, peers: [{ id: "local", name: "Mac mini", url: "http://127.0.0.1:1" }] });
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: true });
const path = join(root, "worker.jsonl"); writeFileSync(path, "");
const state = { sessionId: "worker", runtimeGeneration: "generation-1", runtimeStatus: "live", revision: 0, requests: [], running: false };
const events = new Set(); const ui = new Set(); const receipts = new Map(); let submissions = 0;
const snapshot = () => structuredClone({ sessionId: state.sessionId, runtimeGeneration: state.runtimeGeneration, runtimeStatus: state.runtimeStatus, revision: state.revision, requests: state.requests });
const publish = (requests = state.requests) => { state.requests = requests; state.revision++; for (const listener of ui) listener(snapshot()); };
const session = {
  sessionId: "worker", sessionFile: path, cwd: root,
  inner: { sessionManager: { getHeader: () => ({ id: "worker", cwd: root }), getEntries: () => [], getSessionFile: () => path, getSessionName: () => "远程实现", buildSessionContext: () => ({ messages: [] }) }, agent: { state: { messages: [] } } },
  isAlive: () => state.runtimeStatus === "live", isRunning: () => state.running,
  getPendingUiRequestsSnapshot: snapshot,
  subscribeUiRequests(listener) { ui.add(listener); return () => ui.delete(listener); },
  onEvent(listener) { events.add(listener); return () => events.delete(listener); },
  async send(command) {
    if (command.type === "get_state") return { sessionId: "worker", isPromptRunning: state.running };
    if (command.type !== "extension_ui_response") throw new Error("Unexpected command");
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    if (command.runtimeGeneration !== state.runtimeGeneration) fail("ui_generation_mismatch");
    const prior = receipts.get(command.id);
    if (prior) { if (JSON.stringify(prior.command) !== JSON.stringify(command)) fail("ui_request_conflict"); return { ...prior.receipt, status: "replayed" }; }
    const request = state.requests.find(item => item.id === command.id);
    if (!request) fail("ui_request_unknown");
    if (request.expiresAt && request.expiresAt <= Date.now()) fail("ui_request_expired");
    if (!command.cancelled && (request.method === "select" ? !request.options.includes(command.value) : request.method === "confirm" ? typeof command.confirmed !== "boolean" : typeof command.value !== "string")) fail("ui_response_invalid");
    const receipt = { status: "accepted", id: command.id, runtimeGeneration: state.runtimeGeneration, resolution: command.cancelled ? "cancelled" : "answered" };
    receipts.set(command.id, { command, receipt }); submissions++;
    const next = state.requests.filter(item => item.id !== command.id);
    if (command.value === "手动输入") next.push(popup("manual", "input"));
    publish(next); return receipt;
  },
};
function popup(id, method = "select") { return { id, method, runtimeGeneration: state.runtimeGeneration, title: "选择下一步", options: method === "select" ? ["继续", "手动输入"] : undefined, prefill: method === "editor" ? "完整编辑内容🙂\n".repeat(6000) : undefined }; }
globalThis.__piSessions = new Map([["worker", session]]);
const { POST } = await jiti.import("../../app/api/session-control/live/route.ts");
const { GET } = await jiti.import("../../app/api/session-control/live/events/route.ts");
const server = createServer(async (req, res) => {
  const abort = new AbortController(); res.on("close", () => abort.abort());
  try {
    const url = `http://127.0.0.1:${server.address().port}${req.url}`;
    if (req.url.startsWith("/fixture/")) {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/fixture/publish") publish((body.requests || []).map(item => ({ ...popup(item.id, item.method), ...item })));
      if (req.url === "/fixture/restart") { state.runtimeGeneration = body.generation; publish([]); }
      if (req.url === "/fixture/settle") { state.running = false; for (const listener of events) listener({ type: "agent_settled" }); }
      if (req.url === "/fixture/run") state.running = true;
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ submissions, uiListeners: ui.size, eventListeners: events.size, ...snapshot() })); return;
    }
    let raw = ""; if (req.method !== "GET") for await (const chunk of req) raw += chunk;
    const request = new Request(url, { method: req.method, headers: req.headers, signal: abort.signal, ...(raw ? { body: raw } : {}) });
    const response = req.method === "GET" ? await GET(request) : await POST(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).on("error", () => res.destroy()).pipe(res); else res.end();
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
server.listen(0, "127.0.0.1", () => process.send({ url: `http://127.0.0.1:${server.address().port}` }));
process.on("message", message => { if (message === "close") { server.closeAllConnections(); server.close(() => process.exit(0)); } });
