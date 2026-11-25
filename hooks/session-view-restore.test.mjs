import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { getSessionViewSnapshot, setSessionViewSnapshot, resetSessionViewCacheForTests } = await jiti.import("../lib/session-view-cache.ts");
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("a warmed snapshot paints immediately, restores plan, and preserves paged history after fast validation", async () => {
  const previousFetch = globalThis.fetch, previousDocument = globalThis.document;
  const previousWindow = globalThis.window, previousSource = globalThis.EventSource;
  resetSessionViewCacheForTests();
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  globalThis.window = Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem: () => {} } });
  globalThis.EventSource = class {
    readyState = 0;
    constructor() { queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
    close() { this.readyState = 2; }
  };
  const id = "warm-view-restore";
  const model = { provider: "fixture", modelId: "fixture" };
  const entryIds = Array.from({ length: 100 }, (_, index) => `e${index}`);
  const messages = entryIds.map((entryId) => ({ role: "user", content: entryId }));
  const toolNames = ["read", "grep", "find", "ls"];
  setSessionViewSnapshot({
    sessionId: id, revision: "warm-r1", messages, entryIds, leafId: "e99", oldestEntryId: "e0",
    hasMore: true, turnsBefore: 7, summaryTree: [], thinkingLevel: "medium", model,
    toolNames, loadedEntryIds: entryIds, totalActiveMs: 100,
  });
  let detailReads = 0;
  const unexpected = [];
  let releaseDetail;
  const detailGate = new Promise((resolve) => { releaseDetail = resolve; });
  globalThis.fetch = async (url, init = {}) => {
    if (url === `/api/agent/${id}/lease` && init.method === "POST") {
      return Response.json({ success: true, running: false, awaitingInput: false, subagentsActive: false });
    }
    if (url.startsWith(`/api/sessions/${id}?`)) {
      detailReads++;
      await detailGate;
      return Response.json({
        sessionId: id, filePath: "", snapshotRevision: "warm-r1", treeFormat: "summary", tree: [],
        leafId: "e99", toolNames, totalActiveMs: 100,
        context: {
          messages: messages.slice(-50), entryIds: entryIds.slice(-50), oldestEntryId: "e50",
          hasMore: true, turnsBefore: 57, thinkingLevel: "medium", model,
        },
      });
    }
    if (url === `/api/sessions/${id}/state`) return Response.json({ running: false });
    if (url.startsWith("/api/models")) return Response.json({
      models: {}, modelList: [{ provider: model.provider, id: model.modelId, name: "Fixture" }],
      defaultModel: model, defaultThinkingLevel: "medium", thinkingLevels: { "fixture:fixture": ["off", "medium"] },
    });
    if (url === `/api/agent/${id}?systemPrompt=0` || url === `/api/agent/${id}`) return Response.json({ running: false });
    unexpected.push(url);
    throw new Error(`unexpected fetch ${url}`);
  };
  let hook;
  try {
    hook = renderHook(useAgentSession, { session: { id, cwd: "/fixture" } });
    hook.flush();
    assert.equal(hook.result.messages.length, 100, "cached content is visible before the network reply");
    assert.equal(hook.result.loading, false);
    assert.equal(hook.result.toolPreset, "read-only", "do not flash build for a cached plan session");
    // Resolve the foreground read before an additional hook flush, stressing the refs primed on mount.
    releaseDetail();
    await settle(); hook.flush();
    assert.equal(detailReads, 1);
    assert.deepEqual(unexpected, [], "status mocks must match even when the hook catches fetch errors");
    assert.equal(hook.result.messages.length, 100);
    assert.equal(hook.result.earlierTurnCount, 7);
    const cached = getSessionViewSnapshot(id);
    assert.equal(cached.messages.length, 100);
    assert.equal(cached.entryIds.length, 100, "the second cache write must not truncate only entry ids");
    assert.equal(cached.oldestEntryId, "e0");
    assert.deepEqual(cached.toolNames, toolNames);
    hook.unmount(); hook = null;
    assert.equal(getSessionViewSnapshot(id).messages.length, 100, "unmount keeps the warmed snapshot revision");
  } finally {
    releaseDetail();
    hook?.unmount();
    resetSessionViewCacheForTests();
    globalThis.fetch = previousFetch;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.EventSource = previousSource;
  }
});

for (const flushAfter404 of [true, false]) {
  test(`a warmed session returning 404 stays out of the cache ${flushAfter404 ? "after repaint" : "even before repaint"}`, async (t) => {
    const previous = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, EventSource: globalThis.EventSource };
    resetSessionViewCacheForTests();
    t.after(() => { Object.assign(globalThis, previous); resetSessionViewCacheForTests(); });
    globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    globalThis.window = new EventTarget();
    globalThis.EventSource = class {
      readyState = 0;
      constructor() { queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
      close() { this.readyState = 2; }
    };
    const id = "deleted-warm-view";
    setSessionViewSnapshot({
      sessionId: id, revision: "deleted-r1", messages: [{ role: "user", content: "old transcript" }],
      entryIds: ["old"], leafId: "old", oldestEntryId: "old", hasMore: true, turnsBefore: 3,
      summaryTree: [], loadedEntryIds: ["old"],
    });
    const detail = Promise.withResolvers();
    const olderPage = Promise.withResolvers();
    globalThis.fetch = async (url) => {
      if (url.startsWith(`/api/sessions/${id}?`)) return detail.promise.then(() => new Response(null, { status: 404 }));
      if (url.startsWith(`/api/sessions/${id}/context?`)) return olderPage.promise;
      if (url.startsWith("/api/models")) return Response.json({ models: {}, modelList: [] });
      return Response.json({ running: false });
    };
    const props = { session: { id, cwd: "/fixture" } };
    const hook = renderHook(useAgentSession, props);
    let open = true;
    t.after(() => { if (open) hook.unmount(); });
    hook.flush();
    assert.equal(hook.result.messages.length, 1, "paint the snapshot while validation is pending");
    const paging = flushAfter404 ? hook.result.loadContext(id, "old", "old") : null;
    detail.resolve();
    await settle();
    assert.equal(getSessionViewSnapshot(id), null);
    if (flushAfter404) {
      olderPage.resolve(Response.json({ context: {
        messages: [{ role: "user", content: "older history" }], entryIds: ["older"],
        oldestEntryId: "older", hasMore: true,
      } }));
      await paging;
      hook.flush();
      assert.deepEqual(hook.result.messages, [], "a stale page cannot refill the cleared view");
      assert.equal(hook.result.activeLeafId, null);
      assert.equal(hook.result.hasEarlierMessages, false);
      assert.equal(hook.result.loading, false);
    }
    hook.unmount(); open = false;
    assert.equal(getSessionViewSnapshot(id), null, "unmount cannot save the rejected snapshot");
    const reopened = renderHook(useAgentSession, props);
    try {
      reopened.flush();
      assert.deepEqual(reopened.result.messages, [], "reopening never paints the deleted history");
      await settle();
    } finally { reopened.unmount(); }
  });
}
