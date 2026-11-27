import { NEW_SESSION_TOOL_PRESET, isToolPreset, type ToolPreset } from "./tool-presets";
import { getBrowserStorage } from "./browser-storage";

const STORAGE_KEY = "pi-tool-preset";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Only an explicit pick from the tool dropdown is ever stored, so a missing value
 * means "never chose". First use starts build; later explicit choices, including
 * historical configured/Chat-only values, still round-trip without rewriting storage.
 */
export function getPreferredToolPreset(
  storage: StorageLike | null = getBrowserStorage(),
): ToolPreset {
  if (!storage) return NEW_SESSION_TOOL_PRESET;
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isToolPreset(value) ? value : NEW_SESSION_TOOL_PRESET;
  } catch {
    return NEW_SESSION_TOOL_PRESET;
  }
}

export function setPreferredToolPreset(
  preset: ToolPreset,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
  } catch {
    // Browser storage is best-effort.
  }
}
