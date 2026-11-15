import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  classifySubagentParentMode, subagentParentCallBlockReason, createLocalSubagentParentPolicyExtension,
} = await createJiti(import.meta.url).import("./local-subagent-parent-policy.ts");
const READ = ["read", "grep", "find", "ls"];
const BUILD = ["read", "bash", "edit", "write"];
const FULL = [...BUILD, "grep", "find", "ls"];
const external = { name: "subagent", description: "In plan/build, children cannot load extensions or MCP" };
const host = { name: "Agent", description: "host", sourceInfo: { path: "<inline:pi-web-subagents>" } };
const steer = { name: "steer_subagent", description: "steer", sourceInfo: { path: "<inline:pi-web-subagents>" } };
const call = (selection, name, input, tools = [external]) => subagentParentCallBlockReason(selection, tools, name, input);

test("mode classification is only for subagents; unpinned/configured retains build admission", () => {
  assert.equal(classifySubagentParentMode(undefined), "build");
  assert.equal(classifySubagentParentMode(READ), "plan");
  assert.equal(classifySubagentParentMode(BUILD), "build");
  assert.equal(classifySubagentParentMode(["read", "powershell", "edit", "write"]), "build");
  assert.equal(classifySubagentParentMode(FULL), "full");
  assert.equal(classifySubagentParentMode([...FULL, "webfetch", "mcp__server__read"]), "full", "extension names do not restrict a full builtin selection");
  assert.equal(classifySubagentParentMode([...BUILD, "webfetch"]), "build");
  assert.equal(classifySubagentParentMode(["read"]), "restricted");
  assert.equal(classifySubagentParentMode(["webfetch"]), "restricted", "a non-coding selection is not Chat only");
  assert.equal(classifySubagentParentMode([]), "none");
});

test("parent tool/MCP calls are not bounded by the subagent-only policy", () => {
  for (const selection of [READ, BUILD, FULL, undefined, [], ["read"]]) {
    for (const name of ["write", "bash", "webfetch", "codemode", "tool_search", "mcp__server__write", "Agent"]) {
      assert.equal(call(selection, name, {}, [external, { name, description: "third-party" }]), undefined, name);
    }
  }
});

test("external dispatcher validates all roles/scopes before single, batch or chain starts", () => {
  for (const selection of [READ, BUILD, undefined]) {
    assert.equal(call(selection, "subagent", { agent: "scout" }), undefined);
    assert.equal(call(selection, "subagent", { tasks: [{ agent: "scout" }, { agent: "planner" }] }), undefined);
    assert.equal(call(selection, "subagent", { chain: [{ agent: "planner" }], agentScope: "user" }), undefined);
    assert.match(call(selection, "subagent", { tasks: [{ agent: "scout" }, { agent: "general-purpose" }] }), /only permits/);
    assert.match(call(selection, "subagent", { agent: "scout", agentScope: "project" }), /user-level/);
    assert.match(call(selection, "subagent", { chain: {} }), /Invalid/);
    assert.match(call(selection, "subagent", { agent: "scout" }, [{ name: "subagent", description: "unvetted" }]), /does not enforce/);
  }
  assert.match(call(READ, "subagent", { agent: "worker" }), /only permits/);
  assert.equal(call(BUILD, "subagent", { tasks: [{ agent: "worker" }, { agent: "reviewer" }] }), undefined);
  assert.equal(call(FULL, "subagent", { agent: "project-custom", agentScope: "project" }), undefined);
});

test("genuine host supersedes external dispatcher in every mode, but not arbitrary tools", () => {
  for (const selection of [READ, BUILD, FULL, undefined]) {
    assert.match(call(selection, "subagent", { agent: "scout" }, [host, external]), /external subagent tool is disabled/);
    assert.equal(call(selection, "get_subagent_result", {}, [host, external]), undefined);
    assert.equal(call(selection, "steer_subagent", { sessionId: "child" }, [host, steer]), undefined, "admitted modes keep steering");
  }
  for (const selection of [[], ["read"]]) {
    assert.match(call(selection, "steer_subagent", { sessionId: "child" }, [host, steer]), /Steering subagents is disabled/);
    assert.equal(call(selection, "get_subagent_result", { sessionId: "child" }, [host]), undefined, "owning-parent result retrieval stays available");
  }
  assert.match(call(READ, "Agent", { subagent_type: "worker" }, [host]), /only permits/);
  assert.equal(call(READ, "Agent", { resume: "child" }, [host]), undefined, "runtime checks continuation provenance");
});

test("extension hides only the superseded dispatcher, preserves tools and adds no parent guidance", () => {
  const handlers = new Map();
  const tools = [host, external, { name: "lookup", description: "extension" }, { name: "mcp__server__write", description: "MCP" }];
  let active = tools.map((tool) => tool.name);
  createLocalSubagentParentPolicyExtension().factory({
    on: (name, handler) => handlers.set(name, handler),
    getAllTools: () => tools, getActiveTools: () => active,
    setActiveTools: (names) => { active = names; },
  });
  const ctx = { sessionManager: { getEntries: () => [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools: READ } }] } };
  handlers.get("session_start")();
  assert.deepEqual(active, ["Agent", "lookup", "mcp__server__write"]);
  const event = { systemPromptOptions: { selectedTools: tools.map((tool) => tool.name), promptGuidelines: [] } };
  handlers.get("before_agent_start")(event, ctx);
  assert.deepEqual(event.systemPromptOptions.selectedTools, active);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, []);
  assert.equal(event.systemPromptOptions.sections, undefined);
  assert.equal(handlers.get("tool_call")({ toolName: "mcp__server__write", input: {}, parentToolCallId: "nested" }, ctx), undefined);
  assert.equal(handlers.get("tool_call")({ toolName: "subagent", input: { agent: "scout" }, parentToolCallId: "nested" }, ctx).block, true);
});
