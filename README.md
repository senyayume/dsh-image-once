# dsh-image-once

中文 | [English](README.en.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <img src="assets/banner.png" alt="dsh-image-once — 每个图片块只在它出现的那一次请求里内联" width="100%">
  </picture>
</p>

[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.1-4c6ef5?style=flat-square&labelColor=454a54)
[![stars](https://img.shields.io/github/stars/senyayume/dsh-image-once?style=flat-square)](https://github.com/senyayume/dsh-image-once/stargazers)

「图片只发一次」：对话里的每个图片块**只在它出现的那一次请求**里以 base64 内联，之后的请求换成 DSH 自带的占位文字（占位文字里带本地只读路径，模型要看时自己 `read_image`）。

[它长什么样](#它长什么样) · [为什么](#为什么) · [做什么](#做什么) · [配置](#配置可选) · [客户端半体](#客户端半体) · [代价](#代价) · [装配](#装配)

## 它长什么样

**设置 → 插件**，找到 `dsh-image-once` 那一行（行右侧开关控制整个插件是否生效）：

![插件页上的插件行与「配置」入口](assets/plugin-row.png)

点该行的「配置」进入本插件页面，就是一张 provider 名单：每行一个开关，关掉即该 provider 完全不进本插件；
行右侧「限定模型」可以把这个 provider 收窄到几个模型 id。改完即时生效、不用重启。

![插件页上的 provider 名单卡片](assets/provider-list.png)

上面两张都是**本机实机截图**（亮色主题，DSH Desktop 自带 harness）。卡片里那几行 provider 是本机装了
哪些 provider 就是哪些——**本插件不认识任何 provider 名**，它只是把宿主注册表里的名字原样列出来。

## 为什么

`dsh-llm-pi-ai` 会把对话里**每个未 offload 的图片出现**在**每一次请求**里重新 base64 内联。于是一旦贴过几张截图，整轮对话的每个 step 都在背几 MB 的请求体。

实测（commandcode，同一张图）：

| 请求体 | 首字节 |
|---|---|
| 49B（纯文本）| 2.5s |
| 350KB | 4.7s |
| 1.36MB | 9-11s |
| 4.10MB（12 张小图）| 25.7-27.6s |
| 4.38MB（1 张大 PNG）| 23.5-26.3s |

同尺寸 body 在 deepseek 官方 / workbuddy 上只要 1-3.5s。原始 TLS 分腿测出 4.38MB **上传**只花 231ms、首字节 33.2s —— 慢在网关侧 ingest，与我们上行无关。

## 做什么

每个「图片出现」= `sessionId + message.id + 内容树路径 + attachmentId`：

- 第一次见到 → 原样内联（保证模型第一次看全），**该请求产出第一个 chunk 后**才记账（失败/重试不算已发）；
- 之后任何请求 → 该出现标 `offloaded: true`，DSH 自带逻辑把它换成带本地只读路径的占位文字；
- 模型 `read_image` 重看 = 新出现 → 再内联一次；
- 带 `purpose` 的辅助请求（会话标题、摘要）不改写、不记账；
- 记账只在内存、只影响本次请求的副本，**不写回会话**；`offloaded` 是共享合同字段（DSH 自己的图片压缩流程也用它）。

### 图片的两种形状，都处理

`read_image` 的返回在**不同 DSH 版本里形状不同**，插件必须都认（否则会静默失效：图片每请求重新内联，却不报任何错）：

| 形状 | 出自 | 结构 |
|---|---|---|
| **扁平** | `app.asar` 内置 dsh 的 `createToolResultMessage` | `{ role: "tool", content: [text, image] }` |
| **嵌套** | profile 里的 `@deepseek-ai/dsh-llm-pi-ai` 的 message 构造 | `{ role: "user", content: [{ type: "tool-result", content: [text, image] }] }` |

插件的扫描与改写**递归进 `tool-result`**，与 DSH 自己 `contentHasImage` 的口径一致。判定用 `sessionId + message.id + 路径 + attachmentId`：顶层路径是纯数字（`"3"`）、嵌套是点分（`"3.1"`），所以升级不会让已记账的顶层图片重发一次。

改写是**逐块重建**：未改动的块（含图片之后的文本、`tool-result` 外壳）原样保留。

## 两个已修的缺陷

都由 `test/host.mjs` 的用例钉住，且**都先验证过「旧代码会失败」**（不是先写测试再让它过）：

1. **丢块** —— 旧实现以 `content.slice(0, index)` 起手、循环里只 push 图片块，于是第一张图**之后**的块全部从请求里静默消失：

   | 原消息 | 旧实现实际发出 |
   |---|---|
   | `[text:A, image, text:B]` | `text:A image(offloaded)` —— **丢 text:B** |
   | `[image, text:"说明"]` | `image(offloaded)` —— **丢整段说明** |

2. **漏嵌套** —— 旧实现只看 `message.content` 顶层，`tool-result` 里的图片完全看不见（`read_image` 结果在嵌套版本上每请求重发）。

判据不是读注释：先用运行面的真实形状把两个缺陷复现成数据，再改，再让同一组用例由红转绿。

## 配置（可选）

**设置 → 插件 → `dsh-image-once` 那一行 → 「配置」**，就是一张 provider 名单：每行一个开关，关掉即该 provider 完全不进本插件。也可以给某个 provider 限定模型（行右侧「限定模型」）。

缺省**对所有 provider、所有模型**生效；关掉某些行 = 只收窄那些 provider。

```yaml
# 界面上改的就是这一段，也可以直接手写在同一位置
- id: image-once
  config:
    providers:
      <适配器注册名>:
        enabled: false                            # 该 provider 完全不进本插件
        models: [deepseek/deepseek-v4.1-flash]    # 只对这些模型生效；空数组 = 该 provider 全部模型
```

语义：**没出现过的 provider = 生效**；`providers` 为空 = 全部 provider 生效。provider 名匹配**适配器注册名**（宿主日志里 `已包裹 provider "commandcode"` 即此名，不是 displayName）；`models` 匹配 `options.model`，也就是模型 id。

改完**即时生效，不用重启**（配置是 volatile 的，本插件每次请求现读）。

### 手写 YAML 的位置与边界

要手写就写 **profile 的补丁文件**（`~/.dsh/profiles/<name>/cordis.patch.yml`），它是对包自带那一行的**覆盖**（补丁层顺序 bundle → profile → home → CLI，后层覆盖前层，且 `config` 是**整块替换**而不是 merge）：

```yaml
- id: image-once
  config:
    providers:
      commandcode:
        models:
          - deepseek/deepseek-v4.1-flash
```

> 这里**不要再写 `insert:`** —— 包自己的 `cordis.patch.yml` 已经插入了 `id: image-once` 这一行，重复 id 会让插件安装的试启动校验回滚。

> 插件 config 由 cordis 作为 `apply(ctx, config)` 的**第二个参数**传入。不要写 `ctx.config`——未注入 `config` 服务的插件访问它会抛 `cannot get property "config" without inject`，宿主会把该 entry 记成 `did not activate`。

> 界面与 YAML 是同一份 stored config，只有一个真源；两边不要同时改。

## 客户端半体

本包有 `dsh.client`（`platform: "web"`）+ `exports["./client"]`，因此浏览器里会加载 `lib/client.js`，在 `plugins.row.config` 槽上按 `key = dsh-image-once#image-once` 注册上面那张名单卡片。该 bundle 是**手写的平台闭包工厂**（`window.__ModuleLoader__.load({id, factory})`，只 `require("react")`，走平台 seed），**没有构建步骤**。

### 配色契约：只用 DSH 自己的 token

卡片的样式表**不写任何颜色字面量**，全部走 `--dsw-alias-*` 角色 token（外加 `--dsw-radius-*`、`--dsw-focus-ring-*`、`--ds-font-family-code`），因此亮/暗主题各自成立、皮肤覆盖也跟着走。

这条规矩是被一次真实事故逼出来的：早先的样式表读的是 `--dsh-text` / `--dsh-border` / `--dsh-accent` / `--dsh-danger`——**这四个名字 DSH 从来没有定义过**（本机 `app.asar` 与 `@deepseek-ai/dsh-client-ui-theme` 里定义数为 0，扫描 31829 个文件同样为 0）。`var()` 引用了不存在的自定义属性时整条声明无效，于是

- 文字色回退到浏览器默认色（亮色主题下接近不可见）；
- 开关/选中态用上了插件自己写的深色兜底值（蓝 `#4c8dff`、`rgba(120,170,255,.22)`）。

**判据（插件页那张截图）**：全部文字实测 `#e6e6e6`（正是 CSS 里写的兜底值），而同一页官方文字是 `#0f1115`；开关胶囊实测正好 `rgb(76,141,255)` = 兜底值 `#4c8dff` 的逐字节相等——不是"看起来像"，是字面值落地。

`test/client.mjs` 现在有一道门禁：抽取 bundle 真正注入的样式表，逐个 `var()` 名字比对**显式白名单**，并要求零颜色字面量。新增 token 前先确认它由 `@deepseek-ai/dsh-client-ui-theme`（或 shipped `ui-primitives`）定义，再进白名单——写错名字会**测试失败**，不再静默渲染成错的颜色。

## 代价

模型对每张图的「视觉记忆」只有内联那一次；之后它只知道这张图存在（sha256 / 尺寸 / 文件名 / 本地只读路径），要再看细节会自己 `read_image`，那次请求再内联一次。对「贴图看一眼然后文字讨论」几乎免费。

## 装配

本地包形态（`dsh.bundle.patch` + `cordis.patch.yml`），用 `dsh plugin --profile <profile> add <本包目录|github:senyayume/dsh-image-once>` 安装，进 `dsh.profile.bundles`，插件页可见、可开关。

`package.json` 的 `peerDependencies` 里必须保留 `@deepseek-ai/schemastery`：宿主半体 `import z from "@deepseek-ai/schemastery"`，而本包在 profile 里是 linked 形态，bare specifier 只会在祖先目录的 `peerDependencies` 里被 `routeLinked` 拦到真实安装目录。

**改了 `lib/index.js`、`lib/client.js`、`cordis.patch.yml` 或 `package.json` 后要整包重启 DSH Desktop**：宿主热重放补丁层时会复用 Node 的 ESM 模块缓存，`.mjs`/`.js` 的改动热更吃不到；`package.json` 的 `dsh.client`/`exports` 变更还要让 client-modules 重新扫描 roster。

## 测试

```sh
node test/run.mjs
```

两半都跑：`test/host.mjs`（请求投影、occurrence 记账键、两种图片形状、上面两个已修缺陷、首个 chunk 后才记账）与 `test/client.mjs`（token 白名单、零颜色字面量门禁、zh/en 键对齐）。`test/run.mjs` 需要 `@deepseek-ai/schemastery` 这个 dev peer，缺了会直接以 `missing dev peer at …` 停下，而不是当成通过。
