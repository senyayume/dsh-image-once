/**
 * dsh-image-once —— 「图片只发一次」：对话里的每个图片块只在它出现的那一次请求里以 base64 发出，
 * 之后的请求换成 DSH 自带的占位文字（占位文字里已经带本地只读路径，模型要看再用 read_image 去读）。
 *
 * 作用范围（插件页 → 本插件行 → 「配置」里改，缺省 = 全生效）
 * --------------------------------------------------------
 * 缺省包裹**所有** provider 的适配器（同一条会话中途切 provider 也一视同仁）。要收窄就在卡片里
 * 逐 provider 关掉，或给某个 provider 限定模型。配置只有一棵 volatile dict（见下面的 `Config`）：
 *
 *   providers:
 *     <适配器注册名>:
 *       enabled: false                             # 该 provider 完全不进本插件逻辑
 *       models: ["deepseek/deepseek-v4.1-flash"]   # 只对这些模型生效；空数组 = 该 provider 全部模型
 *
 * 语义：**没出现过的 provider = 生效**；`providers` 为空 = 全部 provider 生效。这既是本插件最初
 * 「缺省全生效」的默认，也让「单独关掉某个 provider」能在界面上直接表达（反向表达「只让某个
 * provider 生效」= 把其余逐个关掉）。同一棵 dict 也可以直接写在 profile 的 `cordis.patch.yml` 里，
 * 靠**覆盖**（不带 insert）包自带那一行的 config；补丁层顺序 bundle → profile → home → CLI，
 * 非 insert 补丁整块替换 `config`（dsh-app-boot/lib/index.js:2932、:73-107）。这里**不能**再写
 * insert：包自带 cordis.patch.yml 已插入 id: image-once，重复 id 会让安装时的试启动校验报
 * duplicate loader entry id 并回滚。
 * 界面写入走 settings 服务（等价于写同一行 YAML），两条路径同一份真源，不并存。
 *
 * config 走 cordis 的第二个参数：本插件签名是 `apply(ctx, config)`。**不要**写 `ctx.config`——
 * 未注入 "config" 服务的插件访问它会直接抛 `Error: cannot get property "config" without inject`。
 * 官方插件同样用 apply(ctx, config)（dsh-llm-pi-ai/lib/index.js:2531）。
 * `providers` 必须是 `.volatile()`：settings 服务只接受 volatile 字段的写入
 * （dsh-settings/lib/index.js:505-507 对没有 volatile 字段的条目直接抛错），且 volatile-only 变更走
 * loader 的快速路径、不重挂插件（cordis-plugin-loader/lib/index.js:380-382、:393-423）。
 * 本插件**每次请求现读配置**（`providers()` 现取 `.get()`），所以改完即时生效、不用重启。
 *
 * 为什么需要它（实测结论）
 * ----------------------
 * commandcode 网关对请求体大小极敏感：同一张图 350KB body → 4.7s 首字节，4.49MB body → 24.2s
 * （prompt_tokens 都是 1050）；原始 TLS 分腿测出 4.38MB 上传只花 231ms、首字节 33.2s —— 慢在网关侧
 * ingest。而 DSH 的 pi-ai 适配器会把对话里**每个未 offload 的图片出现**在**每一次请求**里重新
 * base64 内联（dsh-llm-pi-ai/lib/index.js:1188-1228），所以贴几张截图后，整轮对话每个 step 都在背
 * 2-6MB 的 body。其它网关（deepseek 官方、workbuddy）同尺寸 body 只要 1-3.5s，所以本插件对它们
 * 是「省流量但不改变体感」——这也是缺省全生效无副作用的原因。
 *
 * 现成的零件（本插件只做判定，不自己内联、不自己编码）
 * ------------------------------------------------
 * - 图片块带 `offloaded: true` 时适配器不再收它：pi-ai 的 `collectImageRefs`
 *   （`if (block.offloaded !== true) refs.set(...)`）不收、`projectOffloadedImages`
 *   把它换成 `offloadedImageText`——那段文字自带本地只读路径：
 *   ` Normalized copy (read-only; may be resized or re-encoded): "<path>" (WxHpx, mediaType)`。
 *   该路径由 `resolveImageAttachmentAccess` 把宿主路径映射进模型执行世界。落盘位置是
 *   `<dshHome>/attachments/v1/`：原图 `objects/<xx>/<sha256>`、真正进 body 的请求变体
 *   `request-images/<xx>/<hash>`；`<dshHome>` 由 dsh-attachment-local 的 `dshHome` 配置决定，
 *   优先级 = 插件配置 > `$DSH_HOME` > `~/.dsh`（dsh-home-paths）。
 *   注意这些符号按**名字**引用、不写行号：一个部署里可能存在多份 pi-ai（app.asar 内置的
 *   一份、profile 下另一份），行号随版本漂移。
 * - 图片出现有两种形状，**都必须处理**：
 *   · 扁平：`{ role: "tool", content: [text, image] }`（app.asar 内置 dsh 的
 *     `createToolResultMessage` 就是这个，用户贴图与 `read_image` 结果都走它）；
 *   · 嵌套：`{ role: "user", content: [{ type: "tool-result", content: [text, image] }] }`
 *     （profile 下的 `@deepseek-ai/dsh-llm-pi-ai` 的 message.js 用这个）。
 *   本插件的扫描与改写**递归进 `tool-result`**，与 DSH 自己 `contentHasImage` 的口径一致；
 *   只看顶层会在嵌套版本上静默失效（图片每请求重新内联且不报错）。
 * - `offloaded` 是共享合同里的字段（dsh-llm 的 ImageBlock；多个包的 typert 声明都有
 *   `offloaded?: true`），不是 pi-ai 私有实现。DSH 自己的 image-offload 压缩流程也只挑
 *   「尚未 offloaded」的出现，所以本插件在请求副本上打的标记不会让压缩流程重复处理或抛错。
 * - 缺的只是**判定规则**：现有 offload 只按字节触发（maxRequestImageBytes），自最老开始、
 *   单向不可逆，没有「这张图已经发过一次了」这种按新旧/按次数的规则。
 *
 * 为什么不写 llm/stream 钩子
 * ------------------------
 * `ctx.on("llm/stream", (options, next) => …)` 只能观察：签名没有 next(值)，而且请求是冻结的
 * （dsh-agent-loop/lib/index.js:1268-1269 `Object.freeze(...)`；消息本身 deepFreeze(structuredClone(...))，
 * dsh-llm/lib/index.js:29-31 freezeMessage）。所以只能包一层适配器。
 * `ctx.llm.registerAdapter()` 服务新 provider 路由，对已注册的 provider 会抛 DUPLICATE_ADAPTER
 * （dsh-llm/lib/index.js:1863）；注册一条新路由（如 `commandcode-once`）会把历史 assistant 消息的
 * replay state 判为「不可复用」（:2247 比较适配器实例身份）。因此本插件**就地替换各 provider 的
 * adapter 实例**：模型路由、缓存、replay 判定全部保持原样，用户也不需要换模型。
 * 替换只动 `ctx.llm.adapters` 这一张内部注册表（`registerAdapter` 就是往它里面写，:1886-1894）；
 * 适配器注册表变化时（`llm/adapters-updated`，emit 点 dsh-llm/lib/index.js:1804-1820，调用点
 * :1843/:1893/:1935/:1944）重新扫描并重包，保证不会悄悄退回「每次都发图」。
 *
 * 判定规则
 * ------
 * 每个「图片出现」= 一个 key：sessionId + message.id + **内容树路径** + attachmentId
 * （跨 provider 共享同一份记账：同一张图在别的 provider 上已经发过，也不重复发）。
 * 路径顶层是纯数字（`"3"`）、嵌套是点分（`"3.1"`），所以历史顶层 key 保持原样、不受升级影响。
 *   · 第一次见到这个 key 的请求：原样内联（用户要的「第一次完整」），并在**该请求产出第一个 chunk 之后**
 *     才记账（失败/重试不算已发，重试仍会内联）。
 *   · 之后任何请求：该次出现标 `offloaded: true` → 变成「占位文字 + 本地路径」。
 *   · 模型后续用 read_image 重新读图 = 一个新出现（新 message.id）→ 同样只内联一次。
 *   · 改写是**逐块重建**：未改动的块（含图片之后的文本、tool-result 外壳）原样保留，绝不丢块。
 *   · 带 `purpose` 的辅助请求（标题、摘要等）不参与判定：不改写、不记账，保持现状。
 *   · 记账只在内存里、只影响被包裹适配器的请求；`offloaded` 标记写在本次请求的副本上，不写回会话。
 *   · 适配器注册表不可读时 fail-closed：不替换任何东西、只打 error 日志，行为等同现状。
 *
 * 装配方式（= 正式的插件包；改动后需**整包重启** DSH Desktop）
 * ------------------------------------------------------------
 * 通过 `dsh plugin --profile <profile> add <本包目录|github:senyayume/dsh-image-once>` 装进 profile
 * （file: 依赖 + dsh.profile.bundles 由 CLI reconcile），所以插件页/市场能看到、能开关。
 * 包内 cordis.patch.yml 只提供一行宿主行（id: image-once, name: dsh-image-once）。
 *
 * 注意：**不要**再在 profile 的 cordis.patch.yml 里手写同 id 的 `- insert:` —— 组合会出现两行同 id，
 * 插件安装/更新的试启动校验报 duplicate loader entry id 并自动回滚。
 *
 * 客户端半体（lib/client.js）＝插件页那张名单卡片
 * --------------------------------------------
 * `dsh.client.platform = "web"` + `exports["./client"]` 让浏览器加载这个手写 bundle（平台闭包工厂
 * 形态，无需构建）。它注册 `plugins.row.config` 上 key = `dsh-image-once#image-once` 的一条槽 ——
 * 插件页那一行出现「配置」按钮的充要条件就是这条带 key 的注册（rowConfigKey = `${包名}#${行id}`，
 * dsh-client-ui-plugin-manager/lib/client.js:27-29、:40-65、:3357）。卡片从槽的 ownerProps 拿
 * `{view, form}`，读写全走 `form.mutate` → `remote.settings.mutate` → settings 服务，
 * **不自己开宿主路由**；provider 目录从 `remote.llm.listProviders()` /
 * `listConfigurableProviders()` 合并（同官方模型页 joinProviderDirectory 的口径）。
 * 宿主半体 import 的 `@deepseek-ai/schemastery` 靠 package.json 的 **peerDependencies** 被 linked
 * 解析拦截到真实安装目录（dsh-app-boot/lib/index.js:1471-1500 routeLinked 只认祖先目录 package.json
 * 的 peerDependencies 键名，:1224-1231 readPeerNames），所以这条 peer 是必需品、不是装饰。
 *
 * 已实跑确认（file:// 直引形态，宿主日志 host/dsh-<日期>.log）
 * ---------------------------------------------------------------------
 * - 启动即包裹：`已包裹 provider "commandcode"`；每张图首次内联打
 *   `dsh-image-once: N 张图已内联发出…`。
 * - `ctx.llm.adapters` 可读；`llm/adapters-updated` 事件可用（pi-ai 重写注册表后能重新包裹）。
 * - `cordis.patch.yml` 的宿主热重放复用 Node ESM 缓存，`.mjs` 改动热更吃不到 → 必须整包重启。
 * - 记账 key = `sessionId + message.id + 内容树路径 + attachmentId`；DSH 在 step 之间不重建
 *   message id（dsh-llm 的 message 构造），所以「同一张图」在整段会话里稳定同一个 key。
 *
 * 两个已修的缺陷
 * -------------
 * 都由 test/host.mjs 的用例钉住（并且都先验证过「旧代码会失败」）：
 * 1. **丢块** —— 旧实现以 `content.slice(0, index)` 起手、循环里只 push 图片块，于是
 *    第一张图**之后**的块全部从请求里静默消失（`[text, image, text]` 丢掉尾部文本，
 *    `[image, text]` 丢掉整段说明）。改为逐块重建。
 * 2. **漏嵌套** —— 旧实现只看 `message.content` 顶层；`read_image` 结果在部分 DSH 版本里
 *    嵌在 `tool-result` 内部，于是那些图片每请求重新内联且不报错。改为递归（与
 *    `contentHasImage` 同口径）。
 * 判据不是读注释：先用真实形状跑探针把两个缺陷复现成数据，再改，再让同一组用例由红转绿。
 */
import z from "@deepseek-ai/schemastery";

export const name = "dsh-image-once";
export const inject = ["llm"];

/**
 * 插件配置：一棵 volatile dict，按**适配器注册名**（provider id）记录是否生效、以及该 provider 下
 * 限定的模型。整体 `volatile()` ⇒ 设置页可写、写完不重挂插件（本插件现读现用，即时生效）。
 * 注意 `.volatile()` 必须挂在 dict 根上：这样 `["providers", 任意 provider 名, …]` 都是 volatile 路径，
 * 新出现的 provider 名也能写（dsh-settings/lib/index.js:151-158 的 isVolatilePath 在根上直接返回 true）。
 */
export const Config = z.object({
  providers: z
    .dict(
      z.object({
        enabled: z.boolean().default(true),
        models: z.array(z.string()).default([]),
      }),
    )
    .default({})
    .volatile(),
});

/**
 * 一次「图片出现」的稳定标识。`path` 是块在**整条消息内容树里**的位置：
 * 顶层是 `"3"`，嵌在 `tool-result` 里是 `"3.1"`（复用 DSH 自己那种
 * `image || tool-result && recurse` 的走法，见 dsh-llm/lib/index.js 的 contentHasImage）。
 * 顶层保持旧的纯数字形式，历史 `sent` 集合因此仍然命中。
 */
function occurrenceKey(scope, message, path, block) {
  const messageId = typeof message?.id === "string" ? message.id : `#${path}`;
  const attachmentId = block?.attachment?.attachmentId ?? "?";
  return `${scope}\u0000${messageId}\u0000${path}\u0000${attachmentId}`;
}

/**
 * 把「已经发过一次」的图片出现标成 offloaded，并收集本次内联的出现。
 * 消息与内容块都是 deepFreeze 的，所以只能造新对象，不能就地改。
 *
 * 两个必须同时成立的性质（都由 test/host.mjs 的用例钉住）：
 *   1. **不丢块** —— 返回的内容是原内容的逐块重建，图片之后的块同样保留。
 *      旧实现从 `content.slice(0, index)` 起手、再只 push 图片，于是第一张图
 *      之后的所有块都从请求里静默消失（`[text, image, text]` 会丢掉尾部文本）。
 *   2. **递归进 `tool-result`** —— `read_image` 的图片在部分 DSH 版本里嵌在
 *      tool-result 块内部；只看顶层会让它每请求重新内联，而且不报错。
 * @returns 新的 messages（无改动时原样返回）与本次待内联的出现 key。
 */
function projectOnce(messages, sessionId, sent) {
  const scope = sessionId === undefined ? "-" : String(sessionId);
  const pending = [];
  let changed = false;

  /** 逐块重建一层内容;`path` 见 occurrenceKey。 */
  const walk = (message, blocks, path) => {
    let next;
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      const here = path === "" ? String(index) : `${path}.${index}`;
      if (block?.type === "image") {
        const key = occurrenceKey(scope, message, here, block);
        if (sent.has(key)) {
          (next ??= blocks.slice(0, index)).push({ ...block, offloaded: true });
          changed = true;
        } else {
          (next ??= blocks.slice(0, index)).push(block);
          pending.push(key);
        }
        continue;
      }
      if (block?.type === "tool-result" && Array.isArray(block.content)) {
        const inner = walk(message, block.content, here);
        if (inner !== block.content) {
          (next ??= blocks.slice(0, index)).push({ ...block, content: inner });
          continue;
        }
      }
      // 普通块（以及内部无改动的 tool-result）原样保留 —— 这一行是「不丢块」的关键。
      if (next !== undefined) next.push(block);
    }
    return next ?? blocks;
  };

  const next = messages.map((message) => {
    const content = message?.content;
    if (!Array.isArray(content)) return message;
    const rebuilt = walk(message, content, "");
    return rebuilt === content ? message : { ...message, content: rebuilt };
  });
  return { messages: changed ? next : messages, pending };
}

/**
 * 这条消息里有没有需要处理的图片（含 `tool-result` 嵌套）。
 * 与 DSH 的 `contentHasImage` 同一口径；只看顶层会让嵌套形状整条消息被跳过。
 */
function hasImageDeep(content) {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => block?.type === "image" || (block?.type === "tool-result" && hasImageDeep(block.content)),
  );
}

/** 首个 chunk 到达后再记账：失败的调用不算「已发」，重试仍会内联。 */
async function* commitOnFirstChunk(stream, commit) {
  let committed = false;
  for await (const chunk of stream) {
    if (!committed) {
      committed = true;
      commit();
    }
    yield chunk;
  }
  if (!committed) commit();
}

/**
 * 包一层适配器：只改进出请求的 messages，其余成员（providerInfo / providerRetryPolicy /
 * imageRequestPricing / listModels / resolveModel / prepareCall 的其余语义）原样转发。
 *
 * 所有 provider 都被包裹（与配置无关），生效与否**每次请求现读**：这样配置一改就立即生效，
 * 既不用重挂插件、也不用重新包裹适配器（重包会换掉 adapter 实例身份，影响 replay 判定）。
 * @param inner - 该 provider 原本的适配器。
 * @param provider - 适配器注册名，用于在配置里查这个 provider 的开关和模型范围。
 * @param sent - 跨 provider 共享的「已内联」记账集合。
 * @param providers - 返回当前配置中 provider 表的函数（现读，见 `apply`）。
 */
function wrapAdapter(inner, provider, sent, note, providers) {
  const applies = (options) => {
    const entry = providers()[provider];
    if (entry === null || typeof entry !== "object") return true;
    if (entry.enabled === false) return false;
    const models = entry.models;
    if (Array.isArray(models) && models.length > 0 && !models.map(String).includes(String(options?.model))) return false;
    return true;
  };
  const dispatch = (streamOf, options) => {
    const messages = options?.messages;
    const hasImage = Array.isArray(messages) && messages.some((m) => hasImageDeep(m?.content));
    if (options?.purpose !== undefined || !hasImage || !applies(options)) return streamOf(options);
    const { messages: rewritten, pending } = projectOnce(messages, options.sessionId, sent);
    if (pending.length === 0) return streamOf({ ...options, messages: rewritten });
    const commit = () => {
      for (const key of pending) sent.add(key);
      note(`dsh-image-once: ${pending.length} 张图已内联发出，后续请求改为「占位文字 + 本地路径」`);
    };
    return commitOnFirstChunk(streamOf({ ...options, messages: rewritten }), commit);
  };

  return new Proxy(inner, {
    get(target, property) {
      if (property === "stream") return (options) => dispatch((next) => target.stream(next), options);
      if (property === "prepareCall")
        return async (provider_, model, signal) => {
          const call = await target.prepareCall(provider_, model, signal);
          return { ...call, stream: (options) => dispatch(call.stream, options) };
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function apply(ctx, config = {}) {
  const note = (message) => ctx.logger.info(message);
  const registry = () => {
    const adapters = ctx.llm?.adapters;
    return adapters instanceof Map ? adapters : undefined;
  };

  /**
   * 现读配置里的 provider 表。`config.providers` 是 schemastery 解析出来的 volatile 引用
   * （cosmokit `createVolatile`：对象被冻结、靠 `.get()` 取当前值，值变化时引用本身不变），
   * 所以这里每次调用都拿得到最新值。宿主没装 schema（例如直接 apply(ctx)）时退化成空表 = 全生效。
   */
  const providers = () => {
    const raw = config?.providers;
    const value = raw !== null && typeof raw === "object" && Symbol.for("cosmokit.volatile.write") in raw ? raw.get() : raw;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  };

  /**
   * 记账跨 provider 共享：请求是无状态的，宿主每一步都把整段历史重发一遍，所以「已经发过了」
   * 说的不是模型记得、而是这一次内联已经付过账。中途切 provider 不该让同一张图再付一次
   * （真要重看，模型自己 read_image 就是一次新出现）。
   * states 则按 provider 分别保存 wrapper/original：注册表里每个 provider 一个槽位。
   */
  const sent = new Set();
  const states = new Map();
  const stateFor = (provider) => {
    let state = states.get(provider);
    if (state === undefined) states.set(provider, (state = { original: undefined, wrapper: undefined }));
    return state;
  };

  /** 扫描注册表：包裹所有 provider（是否生效由每次请求现读的配置决定）。返回处理的 provider 数。 */
  const installAll = () => {
    const adapters = registry();
    if (adapters === undefined) return { ok: false, total: 0, first: [] };
    let total = 0;
    const first = [];
    for (const [provider, registration] of adapters) {
      if (registration?.adapter === undefined) continue;
      total += 1;
      const state = stateFor(provider);
      if (registration.adapter === state.wrapper) continue;
      state.original = registration.adapter;
      state.wrapper = wrapAdapter(state.original, provider, sent, note, providers);
      adapters.set(provider, { ...registration, adapter: state.wrapper });
      first.push(provider);
    }
    if (first.length > 0) ctx.logger.info(`dsh-image-once: 已包裹 provider ${first.map((name) => `"${name}"`).join(", ")}`);
    return { ok: true, total, first };
  };

  const started = installAll();
  if (!started.ok) ctx.logger.error("dsh-image-once: ctx.llm.adapters 不可读，插件不生效（行为等同现状：每次请求都内联图片）");
  else if (started.total === 0) ctx.logger.warn("dsh-image-once: 注册表里还没有可包裹的适配器，等待 llm/adapters-updated");

  ctx.on("llm/adapters-updated", () => {
    try {
      installAll();
    } catch (error) {
      ctx.logger.warn("dsh-image-once: 重新包裹失败", error);
    }
  });

  /** 配置变化只影响判定，不影响包裹；这里只把新的开关状态记一行日志，方便对照界面。 */
  ctx.on("loader/volatile-update", () => {
    try {
      const table = providers();
      const off = Object.entries(table)
        .filter(([, entry]) => entry !== null && typeof entry === "object" && entry.enabled === false)
        .map(([provider]) => `"${provider}"`);
      ctx.logger.info(`dsh-image-once: 名单已更新，当前关闭 ${off.length === 0 ? "（无，全部 provider 生效）" : off.join(", ")}`);
    } catch (error) {
      ctx.logger.warn("dsh-image-once: 读取新名单失败", error);
    }
  });

  ctx.effect(() => () => {
    const adapters = registry();
    if (adapters === undefined) return;
    for (const [provider, state] of states) {
      const registration = adapters.get(provider);
      if (registration?.adapter === state.wrapper && state.original !== undefined) adapters.set(provider, { ...registration, adapter: state.original });
    }
  }, "dsh-image-once: adapter wrapper");
}
