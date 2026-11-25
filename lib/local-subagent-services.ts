import {
  createAgentSessionServices,
  SettingsManager,
  type CreateAgentSessionServicesOptions,
  type AgentSessionServices,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { localSubagentExtensionPaths, type LocalSubagentPolicy } from "./local-subagent-policy";

/** Public ResourceLoader adapter: apply the same discovery guards at every reload entry point. */
function guardedLocalResources(loader: ResourceLoader, prepareReload: () => void): ResourceLoader {
  return {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => loader.getSystemPrompt(),
    getSystemPromptSource: () => loader.getSystemPromptSource(),
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
    extendResources: (paths) => loader.extendResources(paths),
    reload: async (options) => {
      prepareReload();
      await loader.reload(options);
    },
  };
}

/**
 * Full/profile sessions keep normal SDK loading. Limited children use a private, empty resource
 * settings manager: noExtensions alone is too late, since SDK package resolution can install
 * configured packages (and run lifecycle scripts) before filtering discovered extensions.
 * The session itself retains its real settings for models, reasoning, shell preferences, etc.
 * Only project trust is mirrored: the SDK discovers system prompt files even under noContextFiles.
 */
export async function createLocalSubagentServices(
  options: CreateAgentSessionServicesOptions,
  policy?: LocalSubagentPolicy,
): Promise<AgentSessionServices> {
  if (!policy) return createAgentSessionServices(options);
  const settingsManager = options.settingsManager;
  if (!settingsManager) throw new Error("Local subagent services require session settings");
  const discoverySettings = SettingsManager.inMemory({}, { projectTrusted: settingsManager.isProjectTrusted() });
  const ceiling = { ...policy, builtins: [...policy.builtins] };
  // Validate before the SDK's initial reload too, not just subsequent calls through the adapter.
  const additionalExtensionPaths = localSubagentExtensionPaths(ceiling);
  const services = await createAgentSessionServices({
    ...options,
    settingsManager: discoverySettings,
    resourceLoaderOptions: {
      ...options.resourceLoaderOptions,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths,
    },
  });
  return {
    ...services,
    settingsManager,
    resourceLoader: guardedLocalResources(services.resourceLoader, () => {
      localSubagentExtensionPaths(ceiling);
      discoverySettings.setProjectTrusted(settingsManager.isProjectTrusted());
    }),
  };
}
