import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// A `!` command typed in the composer (`executeBash()`): its `user_bash`
// handlers may ask through a dialog, which reaches the page only through the
// session's event stream, and a handler that throws is one notice, the runner's.
// Beside a run, a result pi holds until the run ends shows in its own card,
// which goes with a session read started after the run's end; a second command
// waits, with pi's TUI notice.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");
const { deleteSessionViewSnapshot } = await jiti.import("@/lib/session-view-cache");

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve)); };

async function setup({ fresh }) {
  const sid = fresh ? "s1" : "A";
  const log = [];
  const sources = [];
  // Capture each response before waiting for release(), like an old HTTP reply
  // arriving after a settings write. Normal and held-card cleanup reads gate separately.
  const server = { bash: Promise.withResolvers(), holdReads: false, holdForcedReads: false, held: [], commands: [], completions: [], entries: [], thinkingLevel: "low" };
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); log.push("stream"); }
    close() { this.readyState = 2; }
    emit(event) {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  };
  globalThis.fetch = async (requestUrl, init = {}) => {
    const url = requestUrl.replace("?systemPrompt=0", "");
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url === "/api/agent/new") return json({ sessionId: sid });
    if (url.startsWith(`/api/sessions/${sid}?`)) {
      const forced = url.includes("force=1");
      log.push(forced ? "read:force" : "read");
      const response = json({ sessionId: sid, filePath: `/${sid}.jsonl`, leafId: null, tree: [], treeFormat: "summary", snapshotRevision: `r:${server.entries.map(([id]) => id).join(",")}`, context: { messages: server.entries.map(([, message]) => message), entryIds: server.entries.map(([id]) => id), oldestEntryId: null, hasMore: false, thinkingLevel: server.thinkingLevel, model: { provider: "fixture", modelId: "reasoning" } } });
      if (forced ? server.holdForcedReads : server.holdReads) {
        const release = Promise.withResolvers();
        server.held.push(release.resolve);
        await release.promise;
      }
      return response;
    }
    if (url === `/api/sessions/${sid}/state`) return json({ running: false });
    if (url === `/api/agent/${sid}` && init.body) {
      const command = JSON.parse(init.body);
      server.commands.push(command);
      log.push(command.type);
      if (command.type === "set_thinking_level") server.thinkingLevel = command.level;
      if (command.type !== "bash") return json({ success: true, data: null });
      return server.bash.promise;
    }
    if (url === `/api/agent/${sid}`) return json({ running: false });
    return json({});
  };
  const hook = renderHook(useAgentSession, fresh
    ? { session: null, newSessionCwd: "/project", newSessionDraftKey: "new:draft", t: (key) => key }
    : { session: { id: "A", cwd: "/project", path: "/A.jsonl", name: "A" }, newSessionCwd: null, newSessionDraftKey: null, t: (key) => key, onAgentEnd: (end) => server.completions.push(end) });
  await settle();
  hook.flush();
  const connect = async () => {
    for (const source of sources) if (source.readyState === 0) source.emit({ type: "connected", sessionId: sid, isStreaming: false });
    await settle();
    hook.flush();
  };
  const emit = async (event) => {
    sources.filter((source) => source.readyState === 1).at(-1)?.emit(event);
    await settle();
    hook.flush();
  };
  const notices = () => hook.result.notices.map(({ type, message }) => [type, message]);
  const teardown = () => {
    hook.unmount();
    for (const source of sources) source.close();
    for (const key of ["A", "s1", "new:draft"]) clearDraft(key);
    for (const key of ["A", "s1"]) deleteSessionViewSnapshot(key);
  };
  const release = async () => {
    for (const resolve of server.held.splice(0)) resolve();
    await settle();
    hook.flush();
  };
  return { hook, sid, log, server, connect, emit, release, notices, teardown };
}

async function withSetup(options, body) {
  const originalError = console.error;
  console.error = () => {};
  const env = await setup(options);
  try {
    await body(env);
  } finally {
    console.error = originalError;
    env.teardown();
  }
}

test("a fresh composer's first ! command opens the session's stream before it runs, for a handler's dialog", async () => {
  await withSetup({ fresh: true }, async (env) => {
    const sending = env.hook.result.handleSend("!ask ls");
    await settle();
    assert.deepEqual(env.log, ["stream"], "the command waits for the stream");
    await env.connect();
    assert.deepEqual(env.log, ["stream", "bash"]);
    env.server.bash.resolve(json({ success: true, data: { output: "", exitCode: 0 } }));
    await sending;
  });
});

for (const fresh of [true, false]) {
  test(`a user_bash handler that throws shows the runner's error once (${fresh ? "fresh composer" : "selected session"})`, async () => {
    await withSetup({ fresh }, async (env) => {
      await env.connect();
      const sending = env.hook.result.handleSend("!throw a");
      await settle();
      await env.connect();
      await env.emit({ type: "extension_error", extensionPath: "/ext/ub.js", event: "user_bash", error: "hook exploded" });
      env.server.bash.resolve(json({ error: "hook exploded", code: "extension_reported" }, 500));
      await sending;
      await settle();
      env.hook.flush();
      assert.deepEqual(env.notices(), [["error", "Extension \"/ext/ub.js\" error: hook exploded"]]);
      assert.equal(getDraft(fresh ? "new:draft" : env.sid)?.value, "!throw a", "the command is back in the composer");
    });
  });
}

test("a ! result held for the run's end leaves with a read started after the run, not one joined from agent_end", async () => {
  await withSetup({ fresh: false }, async (env) => {
    await env.connect();
    await env.hook.result.handleSend("first");
    await env.emit({ type: "agent_start" });
    const sending = env.hook.result.handleSend("!echo MARK");
    await settle();
    env.server.bash.resolve(json({ success: true, data: { output: "MARK\n", exitCode: 0 } }));
    await sending;
    await settle();
    env.hook.flush();
    assert.equal(env.hook.result.pendingBash?.result?.output, "MARK\n", "the card shows the result until the run ends");

    // agent_end's read is slow; prompt_done would join it.
    env.server.holdReads = true;
    await env.emit({ type: "agent_end" });
    await env.emit({ type: "agent_settled" });
    await env.emit({ type: "prompt_done" });
    await settle();
    env.hook.flush();
    assert.equal(env.hook.result.agentRunning, false);
    assert.equal(env.hook.result.pendingBash, null, "the run's end reads afresh, and the card goes");
    assert.equal(env.log.at(-1), "read:force");
    await env.release();
    assert.equal(env.hook.result.pendingBash, null);
  });
});

test("a confirmed effort write superseding held-bash cleanup gets a current read without duplicate results", async () => {
  await withSetup({ fresh: false }, async (env) => {
    await env.connect();
    await env.hook.result.handleSend("first");
    await env.emit({ type: "agent_start" });
    const sending = env.hook.result.handleSend("!echo MARK");
    await settle();
    env.server.bash.resolve(json({ success: true, data: { output: "MARK\n", exitCode: 0 } }));
    await sending;
    await settle();
    env.hook.flush();
    assert.ok(env.hook.result.pendingBash?.result);

    // pi persists the held result at the run's end. Keep both prompt_done's
    // normal read and the effect's forced cleanup reply from before the effort ACK.
    env.server.entries = [["bash-result", { role: "bashExecution", command: "echo MARK", output: "MARK\n", exitCode: 0, timestamp: 1 }]];
    env.server.holdReads = true;
    env.server.holdForcedReads = true;
    await env.emit({ type: "agent_settled" });
    await env.emit({ type: "prompt_done" });
    assert.equal(env.hook.result.agentRunning, false);
    assert.equal(env.server.held.length, 2);
    const forcedReads = env.log.filter((entry) => entry === "read:force").length;

    await env.hook.result.handleThinkingLevelChange("high");
    env.hook.flush();
    assert.equal(env.server.commands.at(-1).type, "set_thinking_level");
    assert.equal(env.hook.result.thinkingLevel, "high");
    await env.release();
    assert.equal(env.hook.result.thinkingLevel, "high", "the invalidated low-effort response stays fenced out");
    assert.ok(env.hook.result.pendingBash?.result, "the card stays until a current history response applies");
    assert.equal(env.log.filter((entry) => entry === "read:force").length, forcedReads + 1, "the superseded cleanup retries after the acknowledged write");
    assert.equal(env.server.held.length, 1, "only the current cleanup read is pending");

    env.server.holdReads = false;
    env.server.holdForcedReads = false;
    await env.release();
    assert.equal(env.hook.result.pendingBash, null);
    assert.equal(env.hook.result.messages.filter((message) => message.role === "bashExecution").length, 1);
    assert.deepEqual(env.hook.result.entryIds, ["bash-result"]);
    assert.equal(env.hook.result.thinkingLevel, "high");
    assert.equal(env.server.completions.length, 1, "retrying history is not another completion");
  });
});

test("a concurrent ! stays a shell command and Stop targets the SDK run before the shell", async () => {
  await withSetup({ fresh: false }, async (env) => {
    await env.connect();
    await env.hook.result.handleSend("first");
    await env.emit({ type: "agent_start" });
    const shell = env.hook.result.handleSend("!echo MARK");
    await settle();
    await env.hook.result.handleSteer("correction");
    const prompts = env.server.commands.filter((command) => command.type === "prompt");
    assert.equal(prompts.length, 2, "the ! command is not submitted as another model prompt");
    assert.equal(prompts[0].toolNames, undefined, "ordinary prompts keep the session's tools");
    assert.equal(prompts[1].toolNames, undefined, "steering keeps the session's tools too");
    assert.equal(env.server.commands.some((command) => command.type === "set_tools"), false);

    await env.hook.result.handleAbort();
    assert.equal(env.log.at(-1), "abort");
    await env.emit({ type: "agent_settled", aborted: true });
    await env.emit({ type: "prompt_done", aborted: true });
    assert.deepEqual(env.server.completions, [{ aborted: true }]);
    assert.equal(env.hook.result.bashRunning, true);
    await env.hook.result.handleAbort();
    assert.equal(env.log.at(-1), "abort_bash");
    env.server.bash.resolve(json({ success: true, data: { output: "MARK\n", exitCode: 0 } }));
    await shell;
    await settle();
    env.hook.flush();
    assert.equal(env.hook.result.pendingBash, null);
    assert.deepEqual(env.server.completions, [{ aborted: true }], "shell settlement never re-announces the stopped run");
  });
});

test("a second ! command while one runs comes back with pi's notice", async () => {
  await withSetup({ fresh: false }, async (env) => {
    await env.connect();
    const first = env.hook.result.handleSend("!sleep 5");
    await settle();
    await env.hook.result.handleSend("!ls");
    env.hook.flush();
    assert.deepEqual(env.notices(), [["warning", "chat.bashAlreadyRunning"]]);
    assert.equal(getDraft(env.sid)?.value, "!ls");
    assert.deepEqual(env.log.filter((entry) => entry === "bash"), ["bash"]);
    env.server.bash.resolve(json({ success: true, data: { output: "", exitCode: 0 } }));
    await first;
  });
});
