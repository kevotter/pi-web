import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getPreferredToolPreset,
  setPreferredToolPreset,
} = await jiti.import("./tool-preset-preference.ts");
const { TOOL_PRESET_VALUES, NEW_SESSION_TOOL_PRESET } = await jiti.import("./tool-presets.ts");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("defaults missing or invalid preferences to first-use build without writing storage", () => {
  const empty = createStorage();
  assert.equal(NEW_SESSION_TOOL_PRESET, "default");
  assert.equal(getPreferredToolPreset(empty), NEW_SESSION_TOOL_PRESET);
  assert.equal(empty.values.size, 0);
  const invalid = createStorage({ "pi-tool-preset": "legacy-value" });
  assert.equal(getPreferredToolPreset(invalid), NEW_SESSION_TOOL_PRESET);
  assert.equal(invalid.values.get("pi-tool-preset"), "legacy-value");
  // An explicit earlier pick is still honoured.
  assert.equal(
    getPreferredToolPreset(createStorage({ "pi-tool-preset": "full" })),
    "full",
  );
});

test("round-trips every supported tool preset", () => {
  const storage = createStorage();
  for (const preset of TOOL_PRESET_VALUES) {
    setPreferredToolPreset(preset, storage);
    assert.equal(storage.values.get("pi-tool-preset"), preset);
    assert.equal(getPreferredToolPreset(storage), preset);
  }
});

test("falls back safely when browser storage is unavailable", () => {
  const unavailable = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };

  assert.equal(getPreferredToolPreset(unavailable), NEW_SESSION_TOOL_PRESET);
  assert.doesNotThrow(() => setPreferredToolPreset("full", unavailable));
  assert.equal(getPreferredToolPreset(null), NEW_SESSION_TOOL_PRESET);
  assert.doesNotThrow(() => setPreferredToolPreset("full", null));
});

test("falls back when accessing window.localStorage throws", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const blockedWindow = {};
  Object.defineProperty(blockedWindow, "localStorage", {
    get() { throw new DOMException("blocked", "SecurityError"); },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: blockedWindow,
  });

  try {
    assert.equal(getPreferredToolPreset(), NEW_SESSION_TOOL_PRESET);
    assert.doesNotThrow(() => setPreferredToolPreset("full"));
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
});
