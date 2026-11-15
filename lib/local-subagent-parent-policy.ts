import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { readSessionToolSelection } from "./session-tool-selection";
import type { SessionEntry } from "./types";

// Only subagent admission uses this compatibility classification. Ordinary parent
// tools, MCP, loadout restoration and prompts retain upstream behavior.
export type LocalToolMode = "none" | "plan" | "build" | "full" | "restricted";
export const HOST_SUBAGENT_EXTENSION_PATH = "<inline:pi-web-subagents>";
const HOST_SUBAGENT_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent"]);
// Only built-in coding tools decide the subagent mode. Persisted selections may
// also carry extension names (webfetch, MCP, host controls); they must not turn
// an otherwise full or build selection into a restricted one.
const CODING_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const SUBAGENT_MARKER = "In plan/build, children cannot load extensions or MCP";

export interface SubagentParentTool {
  name: string;
  description: string;
  exposure?: string;
  sourceInfo?: unknown;
}

/** No pin (including configured) keeps the existing subagent-only build ceiling. */
export function classifySubagentParentMode(selection: readonly string[] | undefined): LocalToolMode {
  if (selection === undefined) return "build";
  if (selection.length === 0) return "none";
  const key = selection.filter((name) => CODING_TOOLS.has(name))
    .map((name) => name === "powershell" ? "bash" : name).sort().join(",");
  return key === "find,grep,ls,read" ? "plan"
    : key === "bash,edit,read,write" ? "build"
    : key === "bash,edit,find,grep,ls,read,write" ? "full" : "restricted";
}

export function isHostSubagentTool(tool: SubagentParentTool): boolean {
  const source = tool.sourceInfo;
  return HOST_SUBAGENT_TOOLS.has(tool.name) && typeof source === "object" && source !== null
    && "path" in source && source.path === HOST_SUBAGENT_EXTENSION_PATH;
}

/** Subagent-only guard, including nested external-dispatcher calls. */
export function subagentParentCallBlockReason(
  selection: readonly string[] | undefined,
  tools: readonly SubagentParentTool[],
  toolName: string,
  input: unknown,
): string | undefined {
  if (toolName !== "subagent" && toolName !== "Agent" && toolName !== "steer_subagent") return undefined;
  const tool = tools.find((candidate) => candidate.name === toolName && candidate.exposure !== "hidden");
  if (!tool || toolName === "Agent" && !isHostSubagentTool(tool)) return undefined;
  if (toolName === "steer_subagent") {
    if (!isHostSubagentTool(tool)) return undefined;
    const mode = classifySubagentParentMode(selection);
    // Result retrieval stays available; only continuing a child changes its work.
    return mode === "none" || mode === "restricted"
      ? `Steering subagents is disabled in this session's ${mode} mode.` : undefined;
  }
  if (toolName === "subagent" && tools.some((candidate) => candidate.exposure !== "hidden" && isHostSubagentTool(candidate))) {
    return "The external subagent tool is disabled while Pi Web's built-in subagents are enabled. Use Agent instead.";
  }
  const mode = classifySubagentParentMode(selection);
  if (mode === "full") return undefined;
  if (mode !== "plan" && mode !== "build") {
    return `Subagents are disabled in this session's ${mode} mode.`;
  }
  const roles = mode === "plan" ? ["scout", "planner"] : ["scout", "planner", "worker", "reviewer"];
  const params = input as { subagent_type?: unknown; resume?: unknown; agentScope?: unknown; agent?: unknown; tasks?: unknown; chain?: unknown } | null;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "Invalid plan/build subagent request.";
  if (isHostSubagentTool(tool) && toolName === "Agent") {
    if (!params.resume && params.subagent_type !== undefined
      && (typeof params.subagent_type !== "string" || !roles.includes(params.subagent_type.trim().toLowerCase()))) {
      return `This mode only permits subagent roles: ${roles.join(" / ")}`;
    }
    return undefined; // The host checks profile provenance and continuation at dispatch.
  }
  if (toolName !== "subagent") return undefined;
  // The external extension asserts that it enforces the same child resource ceiling.
  if (!tool.description.includes(SUBAGENT_MARKER)) return "This subagent dispatcher does not enforce the plan/build child resource ceiling.";
  if (params.agentScope !== undefined && params.agentScope !== "user") return "plan/build subagents must use user-level roles.";
  const requested: unknown[] = params.agent === undefined ? [] : [params.agent];
  for (const batch of [params.tasks, params.chain]) {
    if (batch === undefined) continue;
    if (!Array.isArray(batch)) return "Invalid plan/build subagent request.";
    for (const task of batch) requested.push(task?.agent);
  }
  if (requested.some((role) => !roles.includes(role as string))) {
    return `This mode only permits subagent roles: ${roles.join(" / ")}`;
  }
  return undefined;
}

/** Keep the host's dispatcher preference without filtering any other parent tools. */
export function createLocalSubagentParentPolicyExtension(): InlineExtension {
  return {
    name: "pi-web-subagent-parent-policy", hidden: true,
    factory: (pi) => {
      const preferHost = () => {
        if (!pi.getAllTools().some((tool) => tool.exposure !== "hidden" && isHostSubagentTool(tool))) return;
        const active = pi.getActiveTools();
        if (active.includes("subagent")) pi.setActiveTools(active.filter((name) => name !== "subagent"));
      };
      pi.on("session_start", preferHost);
      pi.on("before_agent_start", (event) => {
        preferHost();
        if (pi.getAllTools().some((tool) => tool.exposure !== "hidden" && isHostSubagentTool(tool))) {
          event.systemPromptOptions.selectedTools = (event.systemPromptOptions.selectedTools ?? pi.getActiveTools()).filter((name) => name !== "subagent");
        }
      });
      pi.on("tool_call", (event, ctx) => {
        const reason = subagentParentCallBlockReason(
          readSessionToolSelection(ctx.sessionManager.getEntries() as unknown as SessionEntry[]),
          pi.getAllTools(), event.toolName, event.input,
        );
        return reason ? { block: true, reason } : undefined;
      });
    },
  };
}
