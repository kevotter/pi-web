import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { getLocalePlugin } = await jiti.import("@/lib/i18n/registry");
const { getToolNamesForPreset } = await jiti.import("@/lib/tool-presets");
const render = props => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
  onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {}, onToolPresetChange() {}, ...props,
})));
const button = (html, label) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
  .map(([entry]) => entry).find(entry => entry.includes(`aria-label="${label}"`));

// As in the reasoning-menu tests, execute the actual whole TSX control and its
// initializers for open-menu events. SSR below also exercises the full component.
// No copied menu implementation, mocked preset map, or source-text assertions.
const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(node, matches) {
  if (matches(node)) return node;
  return ts.forEachChild(node, child => find(child, matches));
}
function compile(node) {
  assert.ok(node, "actual component expression exists");
  return new Script(ts.transpileModule(`(${node.getText(source)})`, {
    fileName: "tool-menu.tsx",
    compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText);
}
const control = compile(find(source, node => {
  if (!ts.isJsxExpression(node) || !node.expression || !ts.isBinaryExpression(node.expression)) return false;
  let right = node.expression.right;
  while (ts.isParenthesizedExpression(right)) right = right.expression;
  return ts.isJsxElement(right) && right.openingElement.attributes.properties.some(child => ts.isJsxAttribute(child)
    && child.name.getText(source) === "ref" && child.initializer?.getText(source) === "{toolDropdownRef}");
})?.expression);
const initializers = Object.fromEntries(["TOOL_PRESETS", "TOOL_PRESET_MAP", "controlSize", "toolPresetLabel"].map(name => [name,
  compile(find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name)?.initializer),
]));
function harness({ current, locale = "en", isMobile = false, isStreaming = false, canChange = true, stray = false, openInitially = true } = {}) {
  const calls = [];
  let open = openInitially;
  const context = {
    React, toolPreset: current, isMobile, isStreaming, controlsMenuOpen: false,
    toolDropdownRef: { current: null }, toolDropdownOpen: open,
    t: (key, params = {}) => getLocalePlugin(locale).messages[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name])),
    isStrayClick: () => stray,
    setToolDropdownOpen(next) { open = typeof next === "function" ? next(open) : next; },
    onToolPresetChange: canChange ? preset => calls.push(preset) : undefined,
  };
  for (const [name, script] of Object.entries(initializers)) context[name] = script.runInNewContext(context);
  const element = control.runInNewContext(context);
  const children = React.isValidElement(element) ? React.Children.toArray(element.props.children) : [];
  const trigger = children.find(child => child.type === "button");
  const menu = children.find(child => child.type === "div");
  const rows = menu ? React.Children.toArray(menu.props.children) : [];
  const html = () => renderToStaticMarkup(element);
  return { calls, element, trigger, menu, rows, html, isOpen: () => open,
    label: context.toolPresetLabel, containerStyle: element?.props?.style };
}
const choices = [
  ["read", "read-only", ["read", "grep", "find", "ls"]],
  ["build", "default", ["read", "bash", "edit", "write"]],
  ["full", "full", ["bash", "read", "edit", "write", "grep", "find", "ls"]],
];

test("full component SSR shows truthful current states, including hidden configured/Chat only", () => {
  for (const [toolPreset, label] of [
    [undefined, "From Settings"], ["configured", "From Settings"], ["none", "Chat only"],
    ...choices.map(([label, wire]) => [wire, label]),
  ]) {
    const trigger = button(render({ toolPreset }), "Change tool preset");
    assert.ok(trigger);
    assert.ok(trigger.includes(`title="Change tool preset: ${label}"`));
    assert.ok(trigger.includes(`>${label}</span>`));
    assert.doesNotMatch(trigger, /disabled=/);
  }
});

test("streaming hides the tools control as upstream, retaining Steer/Follow-up/Stop", () => {
  for (const toolPreset of ["configured", "none", "read-only", "default", "full"]) {
    const html = render({ isStreaming: true, toolPreset });
    assert.equal(button(html, "Change tool preset"), undefined);
    assert.ok(button(html, "Steer"));
    assert.ok(button(html, "Follow-up"));
    assert.match(html, /Stop agent/);
    assert.equal(button(html, "Send"), undefined);
    // A stale open-menu state cannot leak the control into a streaming run.
    assert.equal(harness({ current: toolPreset, isStreaming: true }).element, false);
  }
  assert.equal(harness({ canChange: false }).element, undefined);
});

test("actual menu offers only read/build/full, with the unchanged upstream wire values and builtin sets", () => {
  for (const current of [undefined, "configured", "none", "read-only", "default", "full"]) {
    for (const [index, [label, wire, tools]] of choices.entries()) {
      const h = harness({ current });
      assert.deepEqual(h.rows.map(row => React.Children.toArray(row.props.children)[1].props.children), ["read", "build", "full"]);
      assert.equal(h.rows.length, 3);
      assert.deepEqual(h.calls, [], "rendering/opening does not change selection");
      h.rows[index].props.onClick();
      assert.equal(h.isOpen(), false);
      assert.deepEqual(h.calls, current === wire ? [] : [wire], label);
      // Use the real preset resolver, not a new mapping based on display labels.
      assert.deepEqual(getToolNamesForPreset(wire), tools, label);
      if (current !== wire) assert.deepEqual(getToolNamesForPreset(h.calls[0]), tools);
    }
  }
  assert.equal(getToolNamesForPreset("configured"), undefined);
  assert.deepEqual(getToolNamesForPreset("none"), []);
});

test("hidden states are localized and never mark build (or any other choice) selected", () => {
  for (const [locale, configured, none, readDescription, buildDescription, fullDescription] of [
    ["en", "From Settings", "Chat only", "4 read-only built-in tools", "4 built-in tools", "All built-in tools"],
    ["zh-CN", "取自设置", "仅聊天", "4 个只读内置工具", "4 个内置工具", "全部内置工具"],
    ["zh-TW", "取自設定", "僅聊天", "4 個只讀內建工具", "4 個內建工具", "全部內建工具"],
  ]) {
    for (const [current, label] of [[undefined, configured], ["configured", configured], ["none", none]]) {
      const h = harness({ current, locale });
      assert.equal(h.label, label);
      assert.equal(h.rows.filter(row => row.props.style.fontWeight === 600).length, 0);
      assert.deepEqual(h.rows.map(row => React.Children.toArray(row.props.children)[2].props.children),
        [readDescription, buildDescription, fullDescription]);
      assert.doesNotMatch(h.html(), /<polyline/);
    }
    for (const [index, [, current]] of choices.entries()) {
      const h = harness({ current, locale });
      assert.deepEqual(h.rows.map(row => row.props.style.fontWeight === 600), choices.map((_, i) => i === index));
    }
  }
});

test("the trigger only opens/closes the menu and preserves upstream run-end click protection", () => {
  const h = harness({ current: "none", openInitially: false });
  assert.equal(h.menu, undefined);
  h.trigger.props.onClick({});
  assert.equal(h.isOpen(), true);
  h.trigger.props.onClick({});
  assert.equal(h.isOpen(), false);
  assert.deepEqual(h.calls, []);
  const guarded = harness({ openInitially: false, stray: true });
  guarded.trigger.props.onClick({});
  assert.equal(guarded.isOpen(), false);
  assert.deepEqual(guarded.calls, []);
});

test("tools menu keeps upstream mobile strip anchoring and desktop layout", () => {
  for (const isMobile of [false, true]) {
    const h = harness({ isMobile });
    assert.equal(h.containerStyle.position, isMobile ? "static" : "relative");
    assert.equal(h.menu.props.style.right, 0);
    assert.equal(h.menu.props.style.maxWidth, isMobile ? "calc(100vw - 16px)" : undefined);
  }
});
