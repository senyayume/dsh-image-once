/**
 * dsh-image-once 的客户端半体 —— 插件页 → 本插件行 → 「配置」里那张名单卡片。
 *
 * 手写 bundle：平台闭包工厂形态 `window.__ModuleLoader__.load({ id, factory })`，
 * `factory(require) => exports`，**不需要构建步骤**。React / react-dom 由平台 seed 提供，
 * 因此不 require 别的模块、也不需要 peerDependencies。
 *
 * 挂载点：`plugins.row.config`，key = `dsh-image-once#image-once`。
 * 插件页那一行出现「配置」按钮的充要条件就是这条带 key 的注册 ——
 * `rowConfigKey(bundle, rowId) = `${bundle}#${rowId}``（dsh-client-ui-plugin-manager/lib/client.js:27-29），
 * ledger.rows 只收带 options.key 的注册（同文件 :40-65），has(row) 查的正是它（:3357）。
 *
 * props 契约（同文件 :2343、:2388-2405、:3307-3317）：
 *   summary 视图 = `{ view: "summary" }`      —— 不传 form，只给一行摘要
 *   page    视图 = `{ view: "page", form }`   —— form = { state, mutate }
 * `form.state` 是 ConfigFormController.getSnapshot()（dsh-client-ui-settings/lib/client.js:1134-1136）：
 * `{ status, value, base, user, revision, writable, mode }`；`value` 是 projectForm 出来的**纯数据**
 * （volatile 引用已在宿主侧拆开，见 dsh-settings/lib/index.js:97-100 plainConfig）。
 * 写走 `form.mutate(ops, revision)` → `remote.settings.mutate` → settings 服务（同文件 :1177-1194），
 * 返回 Promise<boolean>。**本卡片不自己开宿主路由，也不直接碰 YAML**：界面写入与 profile 补丁层
 * 写的是同一份 stored config，只有一个真源。
 *
 * 路径合法性：宿主 write() 对每个 op 的 path 走 isVolatilePath 校验（dsh-settings/lib/index.js:507）。
 * 本插件的 schema 是 `z.dict(...).volatile()`，volatile 挂在 dict 根上 ⇒
 * `["providers", 任意 provider 名, "enabled"|"models"]` 全部合法，新 provider 名也能写
 * （isVolatilePath 首行 `if (schema.meta.volatile) return true`，同文件 :151-158）。
 *
 * provider 目录来源：`remote.llm.listProviders()`（已注册适配器，= 宿主实际会被包裹的那些）
 * 与 `remote.llm.listConfigurableProviders()`（已声明、可能 dormant 的）合并，口径与官方模型页
 * joinProviderDirectory 一致（dsh-client-ui-settings-models/lib/client.js:907-930、:1009-1013）。
 * 两个调用都返回 `{ ok, value } | { ok: false, error: { message } }` 信封（同文件 :1014-1021、:2810-2818）。
 * 目录只为「让用户看到有哪些 provider 可选」；某个 provider 不在目录里也不影响它已经在配置里的行。
 */
window.__ModuleLoader__.load({
  id: "dsh-image-once",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;

    /** Locale namespace; must equal the `locale` option passed to the slot registration. */
    const NS = "dsh-image-once";
    /** The plugin's row key in the host plugin manager: `<bundle name>#<row id>`. */
    const ROW_KEY = "dsh-image-once#image-once";

    /**
     * Card stylesheet. Every colour comes from DSH's own token set
     * (`--dsw-alias-*` roles plus `--dsw-radius-*` / `--dsw-focus-ring-*` /
     * `--ds-font-family-code`), and **no declaration carries a colour literal**:
     * literals cannot follow the light/dark switch, and a bare `var(--name)` for
     * a name DSH never defines is simply invalid — which is how this card once
     * shipped invisible (near-white text on the light theme). `test/client.mjs`
     * gates the names against a reviewed allowlist, so an invented token fails
     * the suite instead of silently rendering wrong.
     *
     * Geometry mirrors the shipped primitives (`Switch.module.css`,
     * `Tag.module.css`, `Button.module.css`): 36x20 switch, 2px inset, 16px
     * thumb, `corner-shape:round` on pill/circle shapes because the theme
     * applies a global superellipse.
     */
    const CSS = [
      ".dio-card{display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".dio-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dio-title{font-weight:600}",
      ".dio-count{color:var(--dsw-alias-label-tertiary)}",
      ".dio-spacer{flex:1}",
      ".dio-btn{border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);padding:3px 10px;font-size:12px;cursor:pointer}",
      ".dio-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dio-btn:disabled{opacity:.4;cursor:default}",
      ".dio-btn[data-on='true']{background:var(--dsw-alias-interactive-bg-hover-accent);border-color:transparent;color:var(--dsw-alias-label-primary)}",
      ".dio-btn:focus-visible,.dio-switch:focus-visible,.dio-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
      ".dio-note{color:var(--dsw-alias-label-tertiary);line-height:1.5}",
      ".dio-error{color:var(--dsw-alias-state-error-primary);line-height:1.5}",
      ".dio-rows{display:flex;flex-direction:column;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden}",
      ".dio-row{display:flex;align-items:center;gap:10px;padding:8px 10px}",
      ".dio-row+.dio-row{border-top:0.5px solid var(--dsw-alias-border-l2)}",
      ".dio-row[data-off='true']{opacity:.55}",
      ".dio-name{font-weight:500;color:var(--dsw-alias-label-primary)}",
      ".dio-id{color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:var(--ds-font-family-code)}",
      ".dio-badge{font-size:11px;line-height:17px;padding:1px 8px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}",
      ".dio-switch{box-sizing:border-box;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}",
      ".dio-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}",
      ".dio-switch:disabled{opacity:.5;cursor:default}",
      ".dio-knob{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb);transition:transform .12s ease}",
      ".dio-switch[aria-checked='true'] .dio-knob{background:var(--dsw-alias-label-primary-foreground);transform:translateX(16px)}",
      ".dio-models{display:flex;align-items:center;gap:8px;padding:0 10px 9px 58px}",
      ".dio-input{box-sizing:border-box;flex:1;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);padding:4px 8px;font-size:12px;font-family:var(--ds-font-family-code)}",
      ".dio-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
      "@media (prefers-reduced-motion:reduce){.dio-knob{transition:none}}",
    ].join("");

    let cssInjected = false;
    /** Insert the card stylesheet once; the platform has no per-bundle style channel. */
    function injectCss() {
      if (cssInjected || typeof document === "undefined") return;
      cssInjected = true;
      const style = document.createElement("style");
      style.setAttribute("data-dsh-image-once", "");
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const zh = {
      title: "图片只发一次",
      summary: "每张图只在首次请求内联，之后改为「占位文字 + 本地路径」",
      all: "全部",
      on: "已开启",
      off: "已关闭",
      enableAll: "全开",
      disableAll: "全关",
      refresh: "刷新",
      loading: "正在读取配置…",
      unavailable: "配置不可用（宿主未提供设置服务）。",
      readOnly: "当前部署是只读的，无法修改名单。",
      empty: "没有可选 provider。",
      activeBadge: "已注册",
      dormantBadge: "未激活",
      noModels: "留空 = 该 provider 全部模型",
      modelsPlaceholder: "限定模型 id，逗号分隔；留空 = 全部模型",
      modelsLabel: "限定模型",
      footNote: "关闭某一行后，该 provider 完全不进本插件（图片每次请求都照常内联）。名单外与未关闭的 provider 一律生效。改完即时生效，无需重启。",
      failed: "写入失败：{message}",
      counts: "{total} 个 provider，已关闭 {off} 个",
    };
    const en = {
      title: "Send each image once",
      summary: "Each image is inlined on its first request only; later requests use placeholder text plus a local path",
      all: "All",
      on: "Enabled",
      off: "Disabled",
      enableAll: "Enable all",
      disableAll: "Disable all",
      refresh: "Refresh",
      loading: "Reading configuration…",
      unavailable: "Configuration is unavailable (no settings service in this deployment).",
      readOnly: "This deployment is read-only, so the list cannot be changed.",
      empty: "No selectable provider.",
      activeBadge: "registered",
      dormantBadge: "dormant",
      noModels: "empty = every model of this provider",
      modelsPlaceholder: "model ids, comma separated; empty = every model",
      modelsLabel: "Limit models",
      footNote: "Disabling a row keeps that provider out of this plugin entirely (images are inlined on every request again). Providers not listed here, and rows left enabled, stay in effect. Changes apply immediately, without a restart.",
      failed: "Write failed: {message}",
      counts: "{total} providers, {off} disabled",
    };

    /** The plain `providers` dict of one form snapshot, tolerating a missing key. */
    function tableOf(state) {
      const value = state === null || state === void 0 ? void 0 : state.value;
      const providers = value !== null && typeof value === "object" ? value.providers : void 0;
      return providers !== null && typeof providers === "object" && !Array.isArray(providers) ? providers : {};
    }
    /** A provider is in effect unless it is explicitly turned off. */
    function enabledOf(table, provider) {
      const entry = table[provider];
      return !(entry !== null && typeof entry === "object" && entry.enabled === false);
    }
    /** The provider's model whitelist; an empty list means every model. */
    function modelsOf(table, provider) {
      const entry = table[provider];
      if (entry === null || typeof entry !== "object" || !Array.isArray(entry.models)) return [];
      return entry.models.map(String).filter((id) => id.length > 0);
    }
    /** Split a comma/whitespace separated model list, dropping blanks and duplicates. */
    function parseModels(text) {
      const out = [];
      for (const token of String(text).split(/[\s,]+/)) if (token.length > 0 && !out.includes(token)) out.push(token);
      return out;
    }

    /**
     * Build the card component bound to one client context.
     * @param ctx - client root context carrying `remote.llm`.
     * @returns the card component.
     */
    function makeCard(ctx) {
      return function ImageOnceCard(props) {
        const t = typeof props.t === "function" ? props.t : (key) => key;
        const view = props.view;
        const form = props.form;
        const state = form === void 0 ? void 0 : form.state;

        const [directory, setDirectory] = React.useState(null);
        const [failure, setFailure] = React.useState(null);
        const [filter, setFilter] = React.useState("all");
        const [busy, setBusy] = React.useState(false);
        const [expanded, setExpanded] = React.useState(null);
        const [draft, setDraft] = React.useState(null);

        const loadDirectory = React.useCallback(() => {
          let current = true;
          Promise.all([ctx.remote.llm.listProviders(), ctx.remote.llm.listConfigurableProviders()])
            .then(([registered, declared]) => {
              if (!current) return;
              if (!registered.ok) {
                setFailure(registered.error.message);
                setDirectory([]);
                return;
              }
              const rows = new Map();
              for (const entry of registered.value) {
                const provider = String(entry.id);
                rows.set(provider, { provider, displayName: entry.name || provider, active: true });
              }
              if (declared.ok) {
                for (const entry of declared.value) {
                  const provider = String(entry.provider);
                  const known = rows.get(provider);
                  if (known === void 0) rows.set(provider, { provider, displayName: entry.displayName || provider, active: false });
                  else if (entry.displayName) known.displayName = entry.displayName;
                }
              }
              setFailure(null);
              setDirectory([...rows.values()]);
            })
            .catch((error) => {
              if (!current) return;
              setFailure(error instanceof Error ? error.message : String(error));
              setDirectory([]);
            });
          return () => {
            current = false;
          };
        }, []);

        React.useEffect(loadDirectory, [loadDirectory]);

        if (view === "summary") return h("span", { className: "dio-note" }, t("summary"));

        if (state === void 0) return h("div", { className: "dio-card" }, h("div", { className: "dio-note" }, t("unavailable")));
        if (state.status === "loading") return h("div", { className: "dio-card" }, h("div", { className: "dio-note" }, t("loading")));

        const table = tableOf(state);
        const writable = state.writable === true && typeof state.revision === "number";

        const merged = new Map();
        for (const row of directory ?? []) merged.set(row.provider, row);
        for (const provider of Object.keys(table)) {
          if (!merged.has(provider)) merged.set(provider, { provider, displayName: provider, active: false });
        }
        const all = [...merged.values()].sort((left, right) => (left.active === right.active ? left.provider.localeCompare(right.provider) : left.active ? -1 : 1));
        const rows = all.filter((row) => (filter === "on" ? enabledOf(table, row.provider) : filter === "off" ? !enabledOf(table, row.provider) : true));
        const offCount = all.filter((row) => !enabledOf(table, row.provider)).length;

        /** One queued write; `true` means the host accepted it. */
        const write = (ops) => {
          if (ops.length === 0) return;
          setBusy(true);
          Promise.resolve(form.mutate(ops, state.revision))
            .then((ok) => {
              if (ok === false) setFailure(t("failed", { message: "rejected" }));
            })
            .catch((error) => setFailure(t("failed", { message: error instanceof Error ? error.message : String(error) })))
            .then(() => setBusy(false));
        };
        /** Enable/disable one provider, or many at once when only the flag changes. */
        const applyEnabled = (providers, next) => {
          const ops = [];
          for (const provider of providers) {
            if (next && modelsOf(table, provider).length === 0) ops.push({ op: "unset", path: ["providers", provider] });
            else ops.push({ op: "set", path: ["providers", provider, "enabled"], value: next });
          }
          write(ops);
        };
        const applyModels = (provider, ids) => {
          const before = modelsOf(table, provider);
          if (before.length === ids.length && before.every((id, index) => id === ids[index])) return;
          const keepingEnabled = enabledOf(table, provider);
          if (ids.length === 0 && keepingEnabled) write([{ op: "unset", path: ["providers", provider] }]);
          else if (ids.length === 0) write([{ op: "set", path: ["providers", provider, "models"], value: [] }]);
          else if (keepingEnabled) write([{ op: "set", path: ["providers", provider, "models"], value: ids }]);
          else
            write([
              { op: "set", path: ["providers", provider, "enabled"], value: false },
              { op: "set", path: ["providers", provider, "models"], value: ids },
            ]);
        };

        const filterButton = (id, label) => h("button", { type: "button", className: "dio-btn", "data-on": String(filter === id), onClick: () => setFilter(id) }, label);

        const body = rows.map((row) => {
          const on = enabledOf(table, row.provider);
          const models = modelsOf(table, row.provider);
          const open = expanded === row.provider;
          const text = draft !== null && draft.provider === row.provider ? draft.text : models.join(", ");
          const cell = h(
            "div",
            { className: "dio-row", "data-off": String(!on), key: row.provider },
            h("span", { className: "dio-name" }, row.displayName),
            h("span", { className: "dio-id" }, row.provider),
            row.active ? null : h("span", { className: "dio-badge" }, t("dormantBadge")),
            h("span", { className: "dio-spacer" }),
            h(
              "button",
              {
                type: "button",
                className: "dio-btn",
                disabled: !writable,
                title: t("modelsPlaceholder"),
                onClick: () => {
                  setDraft(null);
                  setExpanded(open ? null : row.provider);
                },
              },
              models.length === 0 ? t("modelsLabel") : `${t("modelsLabel")} · ${models.length}`,
            ),
            h(
              "button",
              {
                type: "button",
                className: "dio-switch",
                role: "switch",
                "aria-checked": String(on),
                "aria-label": row.provider,
                disabled: !writable || busy,
                onClick: () => applyEnabled([row.provider], !on),
              },
              h("span", { className: "dio-knob" }),
            ),
          );
          if (!open) return cell;
          return h(
            "div",
            { key: row.provider },
            cell,
            h(
              "div",
              { className: "dio-models" },
              h("input", {
                className: "dio-input",
                type: "text",
                value: text,
                disabled: !writable || busy,
                placeholder: t("modelsPlaceholder"),
                onChange: (event) => setDraft({ provider: row.provider, text: event.target.value }),
                onBlur: () => {
                  if (draft === null || draft.provider !== row.provider) return;
                  const ids = parseModels(draft.text);
                  setDraft(null);
                  applyModels(row.provider, ids);
                },
                onKeyDown: (event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setDraft(null);
                },
              }),
            ),
          );
        });

        return h(
          "div",
          { className: "dio-card" },
          h(
            "div",
            { className: "dio-head" },
            h("span", { className: "dio-title" }, t("title")),
            h("span", { className: "dio-count" }, t("counts", { total: all.length, off: offCount })),
            h("span", { className: "dio-spacer" }),
            filterButton("all", t("all")),
            filterButton("on", t("on")),
            filterButton("off", t("off")),
            h("button", { type: "button", className: "dio-btn", disabled: !writable || busy, onClick: () => applyEnabled(all.map((row) => row.provider), true) }, t("enableAll")),
            h("button", { type: "button", className: "dio-btn", disabled: !writable || busy, onClick: () => applyEnabled(all.map((row) => row.provider), false) }, t("disableAll")),
            h("button", { type: "button", className: "dio-btn", disabled: busy, onClick: () => loadDirectory() }, t("refresh")),
          ),
          failure === null ? null : h("div", { className: "dio-error" }, failure),
          writable ? null : h("div", { className: "dio-note" }, t("readOnly")),
          rows.length === 0 ? h("div", { className: "dio-note" }, t("empty")) : h("div", { className: "dio-rows" }, body),
          h("div", { className: "dio-note" }, t("footNote")),
        );
      };
    }

    /** Cordis plugin name. */
    const name = "dsh-image-once";
    /**
     * The slot registry, the locale seat, and the llm remote face (provider directory) are
     * this bundle's whole surface. `remote.llm` is a point-named path and must be declared
     * explicitly, exactly as the official models page does.
     */
    const inject = ["slots", "locale", "remote", "remote.llm"];

    /**
     * Client plugin body: register dictionaries and seat the plugin-row config card.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      injectCss();
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-image-once: copy dictionaries");
      const Card = makeCard(ctx);
      ctx.slots.inject("plugins.row.config", () => ctx.slots.register({ name: "plugins.row.config", key: ROW_KEY, locale: NS }, Card));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
