import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { deleteSessionViewSnapshot } = await jiti.import("@/lib/session-view-cache");

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
const BUILD = ["read", "bash", "edit", "write"];
const READ = ["read", "grep", "find", "ls"];

async function setup({ existing = false, tools, preferences = new Map() } = {}) {
  const sid = "preset-fixture";
  const commands = [], creations = [], unexpected = [], sources = [];
  let selection = tools;
  window.localStorage = { getItem: (key) => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) };
  globalThis.EventSource = class {
    readyState = 0;
    constructor() {
      sources.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onmessage?.({ data: JSON.stringify({ type: "connected", sessionId: sid, isStreaming: false }) });
      });
    }
    close() { this.readyState = 2; }
  };
  const state = () => ({ isStreaming: false, isPromptRunning: false, systemPrompt: "fixture", thinkingLevel: "off" });
  globalThis.fetch = async (url, init = {}) => {
    if (url.startsWith("/api/models")) return Response.json({ models: {}, modelList: [] });
    if (url === "/api/agent/new") {
      const body = JSON.parse(init.body);
      creations.push(body);
      selection = body.toolNames;
      return Response.json({ sessionId: sid });
    }
    if (url.startsWith(`/api/sessions/${sid}?`)) return Response.json({
      sessionId: sid, toolNames: selection, tree: [], leafId: null,
      context: { messages: [], entryIds: [], hasMore: false, oldestEntryId: null, thinkingLevel: "off", model: null },
    });
    if (url === `/api/sessions/${sid}/state` || url.startsWith(`/api/agent/${sid}`) && !init.body) {
      return Response.json({ running: false, state: state() });
    }
    if (url === `/api/agent/${sid}` && init.body) {
      const body = JSON.parse(init.body);
      commands.push(body);
      if (body.type === "set_tools") selection = body.toolNames;
      const data = body.type === "get_tools" ? (selection ?? BUILD).map((name) => ({ name, active: true }))
        : body.type === "get_state" ? state() : {};
      return Response.json({ success: true, data });
    }
    unexpected.push(`${init.method ?? "GET"} ${url}`);
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  const hook = renderHook(useAgentSession, existing
    ? { session: { id: sid, cwd: "/project" }, newSessionCwd: null, newSessionDraftKey: null }
    : { session: null, newSessionCwd: "/project", newSessionDraftKey: "new:preset-fixture" });
  await settle(); hook.flush();
  return { hook, commands, creations, preferences, cleanup() {
    hook.unmount();
    for (const source of sources) source.close();
    deleteSessionViewSnapshot(sid);
    assert.deepEqual(unexpected, []);
  } };
}

test("a first fresh chat starts in build without persisting an implicit preference", async () => {
  const env = await setup();
  try {
    assert.equal(env.hook.result.toolPreset, "default");
    await env.hook.result.handleSend("hello");
    assert.deepEqual(env.creations[0].toolNames, BUILD);
    assert.equal(env.commands.find((command) => command.type === "prompt").toolNames, undefined);
    assert.equal(env.preferences.has("pi-tool-preset"), false);
  } finally { env.cleanup(); }
});

for (const [tools, expected] of [[undefined, "configured"], [[], "none"], [READ, "read-only"]]) {
  test(`an existing ${expected} session ignores a different browser preference`, async () => {
    const env = await setup({ existing: true, tools, preferences: new Map([["pi-tool-preset", "full"]]) });
    try { assert.equal(env.hook.result.toolPreset, expected); }
    finally { env.cleanup(); }
  });
}

test("choosing read applies upstream set_tools immediately and seeds the next fresh composer", async () => {
  const preferences = new Map();
  const env = await setup({ existing: true, preferences });
  try {
    await env.hook.result.handleToolPresetChange("read-only"); env.hook.flush();
    assert.equal(env.hook.result.toolPreset, "read-only");
    assert.deepEqual(env.commands.filter((command) => command.type === "set_tools"), [{ type: "set_tools", toolNames: READ }]);
    assert.equal(env.commands.some((command) => command.type === "prompt"), false);
    assert.equal(preferences.get("pi-tool-preset"), "read-only");
  } finally { env.cleanup(); }
  const fresh = await setup({ preferences });
  try {
    assert.equal(fresh.hook.result.toolPreset, "read-only");
    await fresh.hook.result.handleSend("hello");
    assert.deepEqual(fresh.creations[0].toolNames, READ);
  } finally { fresh.cleanup(); }
});
