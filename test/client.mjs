/**
 * Client-bundle test for dsh-image-once.
 * Loads the real bundle through a minimal __ModuleLoader__ host with a tiny React
 * shim, then drives the card: render, toggle one provider, whitelist models, and
 * switch the whole list off — asserting the exact ops sent to form.mutate.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const failures = [];
const check = (label, ok, extra) => {
  if (!ok) failures.push(`${label}${extra === undefined ? "" : ` :: ${extra}`}`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra === undefined ? "" : `  (${extra})`}`);
};

/* ---------------- minimal React shim (hooks + createElement) ---------------- */
const HOOKS = [];
let hookCursor = 0;
let renderCursor = 0;
let rerender = () => {};

const React = {
  createElement(type, props, ...children) {
    if (typeof type === "function") return type({ ...(props ?? {}), children: children.length > 1 ? children : children[0] });
    return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
  },
  useState(initial) {
    const index = hookCursor++;
    if (HOOKS[index] === undefined) HOOKS[index] = typeof initial === "function" ? initial() : initial;
    const set = (next) => {
      HOOKS[index] = typeof next === "function" ? next(HOOKS[index]) : next;
      rerender();
    };
    return [HOOKS[index], set];
  },
  useCallback(fn) {
    const index = hookCursor++;
    HOOKS[index] ??= fn;
    return HOOKS[index];
  },
  useEffect(fn) {
    const index = hookCursor++;
    if (HOOKS[index] === undefined) HOOKS[index] = fn() ?? null;
  },
};

/* ---------------- loader host ---------------- */
const registrations = [];
const disposers = [];
let loaded = null;

/**
 * Capture the card stylesheet. `injectCss()` bails out when `document` is
 * missing, so the gate below stubs just enough DOM for the real injection path —
 * asserting the CSS the browser would actually receive, not a copy kept for tests.
 */
let injectedCss = null;
globalThis.document = {
  createElement: () => ({
    attrs: {},
    textContent: "",
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  }),
  head: {
    appendChild(element) {
      injectedCss = element.textContent;
    },
  },
};

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
      const exports = definition.factory((specifier) => {
        if (specifier === "react") return React;
        throw new Error(`client bundle required an unexpected module: ${specifier}`);
      });
      loaded.exports = exports;
    },
  },
};

const source = fs.readFileSync(join(here, "..", "lib", "client.js"), "utf8");
new Function("window", source)(globalThis.window);

check("bundle declares the package id", loaded !== null && loaded.id === "dsh-image-once", loaded === null ? "no load() call" : loaded.id);
const exports_ = loaded.exports;
check("exports apply/inject/name", typeof exports_.apply === "function" && Array.isArray(exports_.inject) && exports_.name === "dsh-image-once", JSON.stringify({ inject: exports_.inject, name: exports_.name }));
check("inject declares remote.llm", exports_.inject.includes("remote.llm") && exports_.inject.includes("slots") && exports_.inject.includes("locale"), JSON.stringify(exports_.inject));

/* ---------------- fake client context ---------------- */
const dictionaries = {};
const registered = [];
const ctx = {
  effect: (fn) => {
    const dispose = fn();
    if (typeof dispose === "function") disposers.push(dispose);
  },
  locale: {
    register: (ns, dicts) => {
      dictionaries[ns] = dicts;
    },
    bind: (ns) => (key, params) => {
      // `register(ns, { zh, en })` stores one dict per locale id; resolve like the
      // real locale service does (current locale, falling back through the chain).
      const dicts = dictionaries[ns] ?? {};
      const table = dicts.zh ?? dicts.en ?? {};
      const text = table[key] ?? key;
      if (params === undefined) return text;
      return String(text).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
    },
  },
  slots: {
    inject: (target, fn) => {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
    },
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
  },
  remote: {
    llm: {
      listProviders: async () => ({ ok: true, value: [{ id: "commandcode", name: "CommandCode" }, { id: "buddy", name: "Buddy" }] }),
      listConfigurableProviders: async () => ({ ok: true, value: [{ provider: "deepseek-account", displayName: "DeepSeek" }] }),
    },
  },
};

exports_.apply(ctx);

check("registers one dictionary set", Object.keys(dictionaries).includes("dsh-image-once"), JSON.stringify(Object.keys(dictionaries)));
check("zh/en dictionaries present", typeof dictionaries["dsh-image-once"]?.zh?.summary === "string" && typeof dictionaries["dsh-image-once"]?.en?.summary === "string");
check("registers exactly one slot", registered.length === 1, String(registered.length));
check("slot is plugins.row.config keyed by the row", registered[0]?.options?.name === "plugins.row.config" && registered[0]?.options?.key === "dsh-image-once#image-once", JSON.stringify(registered[0]?.options));
check("slot carries the locale namespace", registered[0]?.options?.locale === "dsh-image-once");

/* ---------------- stylesheet gate: DSH token names and no colour literals ------
 * The card shipped invisible on the light theme because it read `--dsh-text` /
 * `--dsh-border` / `--dsh-accent` / `--dsh-danger`: names DSH never defines, so
 * every declaration was invalid and the text fell back to the UA default (the
 * platform's own palette lives in `--dsw-alias-*`). A typo here is invisible to
 * behavioural tests, so the stylesheet is checked against an explicit allowlist
 * of token names verified against the shipped theme.
 *
 * Adding a token to this list means: confirm it is defined by
 * `@deepseek-ai/dsh-client-ui-theme` (or the shipped `ui-primitives` sheets)
 * before trusting it in both themes.
 */
const ALLOWED_TOKENS = new Set([
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-bg-module-platform",
  "--dsw-alias-border-l2",
  "--dsw-alias-border-l3",
  "--dsw-alias-border-l4",
  "--dsw-alias-brand-primary",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-interactive-bg-hover-accent",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-primary-foreground",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-state-business-primary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-switch-thumb",
  "--dsw-focus-ring-color",
  "--dsw-focus-ring-width",
  "--dsw-radius-md",
  "--dsw-radius-sm",
  "--ds-font-family-code",
]);

{
  check("the card injects its stylesheet", typeof injectedCss === "string" && injectedCss.length > 0, String(injectedCss === null ? "never injected" : injectedCss.length));

  const referenced = [...new Set([...String(injectedCss).matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((match) => match[1]))].sort();
  const unknown = referenced.filter((name) => !ALLOWED_TOKENS.has(name));
  check("every var() names a token DSH actually defines", unknown.length === 0, unknown.length ? `unknown: ${unknown.join(", ")}` : `${referenced.length} tokens`);

  // A literal would freeze one theme's palette into the other's rendering.
  const literals = [...String(injectedCss).matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)].map((match) => match[0]);
  check("no hard-coded colour literals in the stylesheet", literals.length === 0, literals.length ? `found: ${[...new Set(literals)].join(", ")}` : "token-only");

  // The switch's visual state must key off the same attribute assistive tech reads.
  const switchRules = String(injectedCss).match(/\.dio-switch[^{]*\{[^}]*\}/g) ?? [];
  const stateRules = switchRules.filter((rule) => /aria-checked='true'/.test(rule));
  check("switch on-state is keyed off aria-checked", stateRules.length >= 1 && !/\.dio-switch\[data-on/.test(String(injectedCss)), `${stateRules.length} rule(s)`);
}

/* ---------------- drive the card ---------------- */
const Card = registered[0].component;
const writes = [];
let mutateResult = true;
const mutate = (ops, revision) => {
  writes.push({ ops, revision });
  return Promise.resolve(mutateResult);
};

/** Render the card for one form snapshot, flushing microtasks. */
let generation = 0;
async function render(state, view = "page") {
  HOOKS.length = 0;
  hookCursor = 0;
  renderCursor = 0;
  const mine = ++generation;
  let output;
  rerender = () => {
    // late promises from an earlier render() must not drive this one
    if (mine !== generation) return;
    hookCursor = 0;
    renderCursor += 1;
    if (renderCursor > 40) throw new Error("render loop");
    output = Card({ t: ctx.locale.bind("dsh-image-once"), view, form: { state, mutate } });
  };
  rerender();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // effects may have scheduled state (provider directory); render once more
  hookCursor = 0;
  output = Card({ t: ctx.locale.bind("dsh-image-once"), view, form: { state, mutate } });
  return output;
}

/** Depth-first walk collecting every element. */
function walk(node, out = []) {
  if (node === null || node === void 0 || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (typeof node === "object" && node.type !== undefined) {
    out.push(node);
    walk(node.props?.children, out);
  }
  return out;
}
const textOf = (node) =>
  walk(node)
    .flatMap((el) => (typeof el.props?.children === "string" || typeof el.props?.children === "number" ? [String(el.props.children)] : []))
    .join(" | ");

const snapshot = (providers) => ({
  status: "ready",
  value: { providers },
  base: {},
  user: { providers },
  revision: 7,
  writable: true,
  mode: "user",
});

/* summary view */
{
  const out = await render(snapshot({}), "summary");
  check("summary view renders one short line", out.type === "span" && typeof out.props.children === "string", JSON.stringify(out).slice(0, 120));
}

/* page view, unconfigured: both directory providers listed, all marked on */
{
  const out = await render(snapshot({}));
  const text = textOf(out);
  check("page lists registered providers", text.includes("CommandCode") && text.includes("commandcode") && text.includes("Buddy"), text.slice(0, 200));
  check("page lists declared provider", text.includes("deepseek-account"), text.slice(0, 200));
  const switches = walk(out).filter((el) => el.props?.role === "switch");
  check("one switch per provider", switches.length === 3, String(switches.length));
  check("default state is on", switches.every((el) => el.props["aria-checked"] === "true"), JSON.stringify(switches.map((el) => el.props["aria-checked"])));
  const counts = walk(out).find((el) => String(el.props?.className).includes("dio-count"));
  check("count line says 3 providers / 0 disabled", textOf(counts) === "3 个 provider，已关闭 0 个", textOf(counts));
}

/* toggling a provider off writes exactly one set op */
{
  const out = await render(snapshot({}));
  const switches = walk(out).filter((el) => el.props?.role === "switch");
  const target = switches.find((el) => el.props["aria-label"] === "buddy");
  check("found the buddy switch", target !== undefined, JSON.stringify(switches.map((el) => el.props["aria-label"])));
  writes.length = 0;
  target.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("toggle off writes one op", writes.length === 1 && writes[0].ops.length === 1, JSON.stringify(writes));
  check(
    "toggle off sets enabled=false",
    JSON.stringify(writes[0]?.ops) === JSON.stringify([{ op: "set", path: ["providers", "buddy", "enabled"], value: false }]),
    JSON.stringify(writes[0]?.ops),
  );
  check("write uses the snapshot revision", writes[0]?.revision === 7, String(writes[0]?.revision));
}

/* toggling a disabled provider back on removes the key */
{
  const out = await render(snapshot({ buddy: { enabled: false } }));
  const switches = walk(out).filter((el) => el.props?.role === "switch");
  const target = switches.find((el) => el.props["aria-checked"] === "false");
  check("disabled row renders off", target !== undefined);
  writes.length = 0;
  target.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    "toggle on unsets the key",
    JSON.stringify(writes[0]?.ops) === JSON.stringify([{ op: "unset", path: ["providers", "buddy"] }]),
    JSON.stringify(writes[0]?.ops),
  );
}

/* disabling a provider that already has a model whitelist keeps the whitelist */
{
  const out = await render(snapshot({ commandcode: { models: ["a/b"] } }));
  const switches = walk(out).filter((el) => el.props?.role === "switch");
  const target = switches.find((el) => el.props["aria-checked"] === "true" && el.props["aria-label"] === "commandcode");
  check("target row is the whitelisted one", target !== undefined, JSON.stringify(switches.map((el) => el.props["aria-label"])));
  writes.length = 0;
  target.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    "disable keeps models by setting only enabled",
    JSON.stringify(writes[0]?.ops) === JSON.stringify([{ op: "set", path: ["providers", "commandcode", "enabled"], value: false }]),
    JSON.stringify(writes[0]?.ops),
  );
}

/* filters */
{
  const state = snapshot({ buddy: { enabled: false } });
  const outAll = await render(state);
  const buttons = walk(outAll).filter((el) => el.type === "button");
  const offFilter = buttons.find((el) => textOf(el) === "已开启" || textOf(el) === "已关闭");
  check("filter buttons present", offFilter !== undefined, JSON.stringify(buttons.map((el) => textOf(el)).slice(0, 12)));
}

/* write failure surfaces on the card */
{
  const out = await render(snapshot({}));
  const switches = walk(out).filter((el) => el.props?.role === "switch");
  mutateResult = false;
  writes.length = 0;
  switches[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  hookCursor = 0;
  const after = Card({ t: ctx.locale.bind("dsh-image-once"), view: "page", form: { state: snapshot({}), mutate } });
  check("rejected write is reported", textOf(after).includes("失败") || textOf(after).includes("failed"), textOf(after).slice(0, 200));
  mutateResult = true;
}

/* read-only deployment disables the switches */
{
  const state = { ...snapshot({}), writable: false };
  const out = await render(state);
  const switches = walk(out).filter((el) => el.props?.role === "switch");
  check("read-only disables every switch", switches.length > 0 && switches.every((el) => el.props.disabled === true), JSON.stringify(switches.map((el) => el.props.disabled)));
}

/* loading / unavailable states */
{
  const loading = await render({ status: "loading", revision: 0, writable: true }, "page");
  check("loading state shows a note", textOf(loading).length > 0, textOf(loading).slice(0, 120));
  const missing = await render(void 0, "page");
  check("missing form shows unavailable note", textOf(missing).length > 0, textOf(missing).slice(0, 120));
}

/* dictionary completeness: every key used by the card exists in both locales */
{
  const zh = dictionaries["dsh-image-once"].zh;
  const en = dictionaries["dsh-image-once"].en;
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  check("zh and en expose the same keys", JSON.stringify(zhKeys) === JSON.stringify(enKeys), `zh=${zhKeys.length} en=${enKeys.length}`);
  const loaded = await render(snapshot({ buddy: { enabled: false } }));
  check("dictionary renders a footNote", textOf(loaded).includes("图片每次请求都照常内联") || textOf(loaded).includes("照常"), textOf(loaded).slice(-160));
}

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILURE(S):\n${failures.join("\n")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
