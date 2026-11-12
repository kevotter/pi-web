import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const BUILD = ["read", "bash", "edit", "write"];
const PLAN = ["read", "grep", "find", "ls"];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("session did not reach the expected state");
}

async function fixture(t, extension) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-bash-integration-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const faux = fauxProvider({ models: [{ id: "bash-integration" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager, extensionFactories: [extension],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: root, agentDir, settingsManager, modelRuntime, resourceLoader,
    model: faux.getModel("bash-integration"), sessionManager: SessionManager.inMemory(root),
  });
  const completed = [], events = [];
  const wrapper = new AgentSessionWrapper(session, { onAgentRunComplete: (id) => completed.push(id) });
  t.after(async () => { await wrapper.shutdown(); await rm(root, { recursive: true, force: true }); });
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  return { session, wrapper, faux, completed, events };
}

test("real SDK user_bash results and operations preserve local modes and command-only notification silence", { timeout: 10_000 }, async (t) => {
  const received = [];
  const { session, wrapper, completed, events } = await fixture(t, (pi) => {
    pi.on("user_bash", (event) => {
      received.push(event);
      if (event.command === "handled") return { result: { output: "handled output", exitCode: 0, cancelled: false, truncated: false } };
      if (event.command === "refused") throw new Error("hook refused");
      return { operations: { async exec(command, cwd, options) {
        assert.equal(command, "custom operations");
        assert.equal(cwd, event.cwd);
        assert.equal(options.env, undefined, "do not leak host env into extension operations");
        options.onData(Buffer.from("remote output"));
        return { exitCode: 0 };
      } } };
    });
  });
  wrapper.setActiveToolSelection(PLAN);
  assert.equal((await wrapper.send({ type: "bash", command: "handled", excludeFromContext: true })).output, "handled output");
  assert.equal((await wrapper.send({ type: "bash", command: "custom operations" })).output, "remote output");
  assert.deepEqual(session.getActiveToolNames(), PLAN);
  const bash = session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "bashExecution");
  assert.deepEqual(bash.map((entry) => [entry.message.command, entry.message.excludeFromContext]), [["handled", true], ["custom operations", false]]);
  await assert.rejects(wrapper.send({ type: "bash", command: "refused" }), (error) => error.code === "extension_reported");
  assert.equal(events.filter((event) => event.type === "extension_error" && event.event === "user_bash").length, 1);
  assert.equal(received.length, 3);
  assert.equal(events.some((event) => event.type === "agent_start"), false);
  assert.deepEqual(completed, []);
});

test("real SDK concurrent bash defers its transcript, streams bounded output, and owes completion only after both finish", { timeout: 10_000 }, async (t) => {
  const request = deferred(), releaseRequest = deferred(), releaseBash = deferred();
  t.after(() => { releaseRequest.resolve(); releaseBash.resolve(); });
  const { session, wrapper, faux, completed, events } = await fixture(t, (pi) => {
    pi.on("user_bash", (event) => ({ operations: { async exec(_command, _cwd, options) {
      options.onData(Buffer.from("x".repeat(20_000) + "\nlast line\n"));
      if (event.command === "held command") await releaseBash.promise;
      else await new Promise((resolve) => setTimeout(resolve, 180));
      return { exitCode: 0 };
    } } }));
  });
  faux.setResponses([async () => {
    request.resolve();
    await releaseRequest.promise;
    return fauxAssistantMessage([fauxText("answer")]);
  }]);
  await wrapper.send({ type: "prompt", message: "task", toolNames: BUILD });
  await request.promise;
  assert.equal(session.isStreaming, true);
  const result = await wrapper.send({ type: "bash", command: "first command" });
  assert.match(result.output, /last line/);
  assert.equal(session.hasPendingBashMessages, true);
  assert.equal(session.sessionManager.getEntries().some((entry) => entry.message?.role === "bashExecution"), false);
  const snapshots = events.filter((event) => event.type === "bash_output");
  assert.ok(snapshots.length > 0);
  assert.equal(snapshots[0].command, "first command");
  assert.ok(snapshots[0].output.length <= 16 * 1024);
  assert.match(snapshots[0].output, /last line/);
  await assert.rejects(wrapper.send({ type: "prompt", message: "mode change", toolNames: PLAN }), /task is running/);
  assert.deepEqual(session.getActiveToolNames(), BUILD);
  const bash = wrapper.send({ type: "bash", command: "held command" });
  await until(() => session.isBashRunning);
  releaseRequest.resolve();
  await until(() => events.some((event) => event.type === "agent_settled"));
  assert.deepEqual(completed, [], "the observed run still waits on the concurrent command");
  releaseBash.resolve();
  await bash;
  await until(() => !wrapper.isRunning());
  assert.deepEqual(completed, [session.sessionId]);
  const commands = session.sessionManager.getEntries().filter((entry) => entry.message?.role === "bashExecution").map((entry) => entry.message.command);
  assert.deepEqual(commands, ["first command", "held command"]);
});

// Real SDK hooks/runner, with execution/record spies so a failed regression can
// never fall through to a host shell (especially the undefined-hook case).
function spyBashHandoff(session) {
  const calls = [];
  session.executeBash = async () => {
    calls.push("executeBash");
    return { output: "unexpected execution", exitCode: 0, cancelled: false, truncated: false };
  };
  session.recordBashResult = () => { calls.push("recordBashResult"); };
  return calls;
}
const cancelledBash = { output: "", cancelled: true, truncated: false };

for (const handoff of ["operations", "undefined", "result", "rejection", "caught-rejection"]) {
  test(`shell Stop prevents a pending real user_bash ${handoff} handoff`, { timeout: 10_000 }, async (t) => {
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const { session, wrapper, completed, events } = await fixture(t, (pi) => {
      pi.on("user_bash", async (event) => {
        if (event.command === "fresh invocation") return { result: { output: "fresh", exitCode: 0, cancelled: false, truncated: false } };
        entered.resolve();
        if (handoff === "caught-rejection") await release.promise.catch(() => undefined);
        else await release.promise;
        if (handoff === "operations") return { operations: { exec: async () => { assert.fail("cancelled operations ran"); } } };
        if (handoff === "result") return { result: { output: "late result", exitCode: 0, cancelled: false, truncated: false } };
        if (handoff === "rejection") throw new Error("late hook rejection");
      });
    });
    const calls = spyBashHandoff(session);
    const pending = wrapper.send({ type: "bash", command: "cancelled invocation" });
    await entered.promise;
    assert.equal((await wrapper.send({ type: "get_state" })).isBashRunning, true);
    await wrapper.send({ type: "abort_bash" });
    // Arbitrary JS is not interrupted: keep the busy lease until it returns.
    assert.equal(wrapper.isRunning(), true);
    if (handoff === "caught-rejection") release.reject(new DOMException("Extension wait cancelled", "AbortError"));
    else release.resolve();
    assert.deepEqual(await pending, cancelledBash);
    assert.deepEqual(calls, []);
    assert.equal(wrapper.isRunning(), false);
    assert.equal((await wrapper.send({ type: "get_state" })).isBashRunning, false);
    assert.equal(events.some((event) => event.type === "agent_start"), false);
    assert.deepEqual(completed, []);
    assert.equal((await wrapper.send({ type: "bash", command: "fresh invocation" })).output, "fresh");
    assert.deepEqual(calls, ["recordBashResult"], "the old shell Stop must not poison the next invocation");
    assert.deepEqual(completed, []);
  });
}

for (const stopShell of [false, true]) {
  test(`run-first Stop ${stopShell ? "then shell Stop cancels" : "alone preserves"} a pending user_bash handoff`, { timeout: 10_000 }, async (t) => {
    const request = deferred(), releaseRequest = deferred(), entered = deferred(), releaseHook = deferred();
    t.after(() => { releaseRequest.resolve(); releaseHook.resolve(); });
    const { session, wrapper, faux, completed } = await fixture(t, (pi) => {
      pi.on("user_bash", async () => {
        entered.resolve();
        await releaseHook.promise;
        return { result: { output: "healthy shell result", exitCode: 0, cancelled: false, truncated: false } };
      });
    });
    faux.setResponses([async () => {
      request.resolve();
      await releaseRequest.promise;
      return fauxAssistantMessage([fauxText("answer")]);
    }]);
    await wrapper.send({ type: "prompt", message: "task" });
    await request.promise;
    const calls = spyBashHandoff(session);
    const pending = wrapper.send({ type: "bash", command: "healthy shell" });
    await entered.promise;
    const stopping = wrapper.send({ type: "abort" });
    releaseRequest.resolve();
    await stopping;
    assert.equal(wrapper.isRunning(), true);
    if (stopShell) await wrapper.send({ type: "abort_bash" });
    releaseHook.resolve();
    const result = await pending;
    assert.equal(result.cancelled, stopShell);
    assert.deepEqual(calls, stopShell ? [] : ["recordBashResult"]);
    assert.deepEqual(completed, [], "a stopped SDK run owes no completion");
    assert.equal(wrapper.isRunning(), false);
  });
}

test("cancelling a pending shell handoff settles only the completion already owed by an observed successful SDK run", { timeout: 10_000 }, async (t) => {
  const request = deferred(), releaseRequest = deferred(), entered = deferred(), releaseHook = deferred();
  t.after(() => { releaseRequest.resolve(); releaseHook.resolve(); });
  const { session, wrapper, faux, completed, events } = await fixture(t, (pi) => {
    pi.on("user_bash", async () => { entered.resolve(); await releaseHook.promise; });
  });
  faux.setResponses([async () => {
    request.resolve();
    await releaseRequest.promise;
    return fauxAssistantMessage([fauxText("answer")]);
  }]);
  await wrapper.send({ type: "prompt", message: "task" });
  await request.promise;
  const calls = spyBashHandoff(session);
  const pending = wrapper.send({ type: "bash", command: "pending hook" });
  await entered.promise;
  releaseRequest.resolve();
  await until(() => events.some((event) => event.type === "agent_settled"));
  assert.deepEqual(completed, []);
  await wrapper.send({ type: "abort_bash" });
  releaseHook.resolve();
  assert.deepEqual(await pending, cancelledBash);
  assert.deepEqual(calls, []);
  assert.deepEqual(completed, [session.sessionId]);
  await wrapper.send({ type: "get_state" });
  assert.deepEqual(completed, [session.sessionId], "completion is claimed only once");
});

test("shell-targeted Stop does not close a concurrent agent dialog", { timeout: 10_000 }, async (t) => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const { session, wrapper, faux, completed, events } = await fixture(t, (pi) => {
    pi.on("context", async (_event, ctx) => { await ctx.ui.confirm("Agent permission", "Leave this dialog open"); });
    pi.on("user_bash", async () => { entered.resolve(); await release.promise; });
  });
  faux.setResponses([fauxAssistantMessage([fauxText("answer")])]);
  await wrapper.send({ type: "prompt", message: "task" });
  await until(() => events.some((event) => event.method === "confirm"));
  const dialog = events.find((event) => event.method === "confirm");
  assert.equal(session.isStreaming, true);
  const calls = spyBashHandoff(session);
  const pending = wrapper.send({ type: "bash", command: "pending shell hook" });
  await entered.promise;
  await wrapper.send({ type: "abort_bash" });
  assert.equal(events.some((event) => event.type === "extension_ui_closed" && event.id === dialog.id), false);
  await wrapper.send({ type: "extension_ui_response", id: dialog.id, confirmed: true });
  await until(() => events.some((event) => event.type === "agent_settled"));
  release.resolve();
  assert.deepEqual(await pending, cancelledBash);
  assert.deepEqual(calls, []);
  assert.deepEqual(completed, [session.sessionId]);
});

test("a fresh user_bash confirmation works after an earlier agent Stop", { timeout: 10_000 }, async (t) => {
  const { session, wrapper, completed, events } = await fixture(t, (pi) => {
    pi.on("user_bash", async (_event, ctx) => {
      const confirmed = await ctx.ui.confirm("Run command?", "Confirm this fresh invocation");
      return { result: { output: confirmed ? "confirmed" : "declined", exitCode: 0, cancelled: false, truncated: false } };
    });
  });
  await wrapper.send({ type: "abort" });
  const pending = wrapper.send({ type: "bash", command: "fresh invocation" });
  const finished = pending.then(() => true, () => true);
  await until(() => events.some((event) => event.method === "confirm") || events.some((event) => event.type === "extension_error"));
  const dialog = events.find((event) => event.type === "extension_ui_request" && event.method === "confirm");
  assert.ok(dialog, "the old Stop must not pre-abort the new hook's dialog");
  await wrapper.send({ type: "extension_ui_response", id: dialog.id, confirmed: true });
  assert.equal((await pending).output, "confirmed");
  await finished;
  assert.equal(session.sessionManager.getEntries().filter((entry) => entry.message?.role === "bashExecution").length, 1);
  assert.deepEqual(completed, []);
});

test("shutdown does not announce an observed run when its pending shell hook returns after closing starts", { timeout: 10_000 }, async (t) => {
  const request = deferred(), releaseRequest = deferred(), entered = deferred(), releaseHook = deferred();
  t.after(() => { releaseRequest.resolve(); releaseHook.resolve(); });
  const { session, wrapper, faux, completed, events } = await fixture(t, (pi) => {
    pi.on("user_bash", async () => { entered.resolve(); await releaseHook.promise; });
  });
  faux.setResponses([async () => {
    request.resolve();
    await releaseRequest.promise;
    return fauxAssistantMessage([fauxText("answer")]);
  }]);
  await wrapper.send({ type: "prompt", message: "task" });
  await request.promise;
  const calls = spyBashHandoff(session);
  const pending = wrapper.send({ type: "bash", command: "pending hook" });
  await entered.promise;
  releaseRequest.resolve();
  await until(() => events.some((event) => event.type === "agent_settled"));
  assert.deepEqual(completed, []);
  const closed = wrapper.shutdown();
  releaseHook.resolve();
  assert.deepEqual(await pending, cancelledBash);
  await closed;
  assert.deepEqual(calls, []);
  assert.deepEqual(completed, []);
});

for (const closing of ["shutdown", "destroy"]) {
  test(`${closing} prevents late user_bash execution and recording`, { timeout: 10_000 }, async (t) => {
    const entered = deferred(), release = deferred(), releaseShutdown = deferred();
    t.after(() => { release.resolve(); releaseShutdown.resolve(); });
    const { session, wrapper, completed } = await fixture(t, (pi) => {
      pi.on("session_shutdown", async () => { await releaseShutdown.promise; });
      pi.on("user_bash", async () => {
        entered.resolve();
        await release.promise;
        return closing === "shutdown"
          ? { result: { output: "late shutdown result", exitCode: 0, cancelled: false, truncated: false } }
          : { operations: { exec: async () => { assert.fail("disposed command executed"); } } };
      });
    });
    const calls = spyBashHandoff(session);
    const pending = wrapper.send({ type: "bash", command: "closing invocation" });
    await entered.promise;
    const closed = closing === "shutdown" ? wrapper.shutdown() : wrapper.destroy();
    assert.equal(wrapper.isAlive(), false);
    release.resolve();
    assert.deepEqual(await pending, cancelledBash);
    assert.deepEqual(calls, []);
    assert.deepEqual(completed, []);
    releaseShutdown.resolve();
    await closed;
  });
}
