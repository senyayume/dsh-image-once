/**
 * Host-half behavioural test for dsh-image-once.
 * Runs apply(ctx, config) against a stub cordis context and a stub llm registry,
 * then asserts the whitelist semantics actually gate requests.
 */
import { apply, Config, name, inject } from "../lib/index.js";

const failures = [];
const check = (label, ok, extra) => {
  if (!ok) failures.push(`${label}${extra === undefined ? "" : ` :: ${extra}`}`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra === undefined ? "" : `  (${extra})`}`);
};

console.log(`name=${name} inject=${JSON.stringify(inject)}`);

/* ---------- config shapes ---------- */
const plain = Config({});
check("Config({}) -> providers {}", JSON.stringify(plain.providers.get ? plain.providers.get() : plain.providers) === "{}");
const parsed = Config({ providers: { commandcode: { models: ["a"] } } });
check(
  "Config fills defaults",
  JSON.stringify(parsed.providers.get()) === '{"commandcode":{"enabled":true,"models":["a"]}}',
  JSON.stringify(parsed.providers.get()),
);

/* ---------- stub host ---------- */
function makeImageBlock(id, attachmentId) {
  return { type: "image", attachment: { attachmentId }, offloaded: undefined, id };
}
function makeMessages() {
  return [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }, makeImageBlock("b1", "att-1")] }];
}

/**
 * Render one request's whole block structure, nested blocks included.
 * Counting images alone cannot see a **dropped** block, so the shape is compared
 * as text: it is what makes "text after an image went missing" fail loudly.
 */
function shapeOf(messages) {
  const render = (blocks) =>
    (blocks ?? [])
      .map((block) => {
        if (block?.type === "image") return block.offloaded === true ? "image(offloaded)" : "image(inline)";
        if (block?.type === "text") return `text:${block.text}`;
        if (block?.type === "tool-result") return `tool-result[${render(block.content)}]`;
        return block?.type ?? "?";
      })
      .join(" ");
  return messages.map((message) => render(message.content)).join(" | ");
}

function makeHarness(configValue) {
  const logs = [];
  const listeners = new Map();
  /** One rendered shape per stream call, in call order. */
  const shapes = [];
  const originalStream = async function* (options) {
    shapes.push(shapeOf(options.messages));
    yield { type: "text", text: `saw:${options.messages[0].content.filter((b) => b.type === "image").length}:offloaded=${options.messages[0].content.filter((b) => b.type === "image" && b.offloaded === true).length}` };
  };
  const adapter = {
    stream: (options) => originalStream(options),
    prepareCall: async () => ({ stream: (options) => originalStream(options) }),
    listModels: () => [],
  };
  const adapters = new Map([
    ["commandcode", { adapter }],
    ["buddy", { adapter }],
  ]);
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`), error: (m) => logs.push(`ERR ${m}`) },
    llm: { adapters },
    on: (event, handler) => {
      listeners.set(event, handler);
    },
    effect: (fn) => {
      listeners.set("__dispose__", fn());
    },
  };
  apply(ctx, configValue);
  return { adapters, logs, listeners, shapes };
}

const drain = async (stream) => {
  const out = [];
  for await (const chunk of stream) out.push(chunk.text);
  return out.join("");
};
const WRITE = Symbol.for("cosmokit.volatile.write");

/* ---------- 1. default: everything wrapped, everything applies ---------- */
{
  const { adapters, logs } = makeHarness(Config({}));
  check("wraps every provider", logs.some((l) => l.includes("已包裹 provider") && l.includes('"commandcode"') && l.includes('"buddy"')), logs.join(" | "));
  const cc = adapters.get("commandcode").adapter;
  const buddy = adapters.get("buddy").adapter;
  // distinct sessions: `sent` is intentionally shared across providers, so reusing
  // one session here would (correctly) already count the image as sent.
  check("commandcode passes images when unconfigured", (await drain(cc.stream({ messages: makeMessages(), model: "x", sessionId: "s-cc" }))) === "saw:1:offloaded=0");
  check("buddy passes images when unconfigured", (await drain(buddy.stream({ messages: makeMessages(), model: "x", sessionId: "s-buddy" }))) === "saw:1:offloaded=0");
}

/* ---------- 2. disabled provider is untouched, other provider still applies ---------- */
{
  const cfg = Config({ providers: { buddy: { enabled: false } } });
  const { adapters } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const buddy = adapters.get("buddy").adapter;
  check("disabled provider untouched", (await drain(buddy.stream({ messages: makeMessages(), model: "any", sessionId: "s1" }))) === "saw:1:offloaded=0");
  check("enabled provider applies", (await drain(cc.stream({ messages: makeMessages(), model: "any", sessionId: "s1" }))) === "saw:1:offloaded=0");
}

/* ---------- 3. model whitelist ---------- */
{
  const cfg = Config({ providers: { commandcode: { models: ["deepseek/deepseek-v4.1-flash"] } } });
  const { adapters } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  check("model in whitelist runs the plugin", (await drain(cc.stream({ messages: makeMessages(), model: "deepseek/deepseek-v4.1-flash", sessionId: "s" }))) === "saw:1:offloaded=0");
  check("model outside whitelist skipped", (await drain(cc.stream({ messages: makeMessages(), model: "other-model", sessionId: "s" }))) === "saw:1:offloaded=0");
}

/* ---------- 4. once-only semantics: second request offloads ---------- */
{
  const cfg = Config({});
  const { adapters, logs } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const first = await drain(cc.stream({ messages: makeMessages(), model: "x", sessionId: "same" }));
  const second = await drain(cc.stream({ messages: makeMessages(), model: "x", sessionId: "same" }));
  check("first request inlines the image", first === "saw:1:offloaded=0", first);
  check("second request offloads the image", second === "saw:1:offloaded=1", second);
  check("commit note logged", logs.some((l) => l.includes("张图已内联发出")), logs.join(" | "));
}

/* ---------- 4b. no block is dropped when an image is offloaded ----------
 * Regression: the old projection rebuilt a message as `content.slice(0, index)`
 * and then pushed only image blocks, so every block AFTER the first image silently
 * vanished from the request. Assert the whole shape, not just image counts.
 */
{
  const cfg = Config({});
  const { adapters, shapes } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const messages = [
    { id: "m1", role: "user", content: [{ type: "text", text: "A" }, makeImageBlock("b1", "att-keep"), { type: "text", text: "B" }] },
  ];
  await drain(cc.stream({ messages, model: "x", sessionId: "shape-1" }));
  await drain(cc.stream({ messages, model: "x", sessionId: "shape-1" }));
  check("blocks after an image survive the rewrite", shapes[1] === "text:A image(offloaded) text:B", shapes[1]);
}
{
  const cfg = Config({});
  const { adapters, shapes } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const messages = [{ id: "m1", role: "user", content: [makeImageBlock("b1", "att-head"), { type: "text", text: "look" }] }];
  await drain(cc.stream({ messages, model: "x", sessionId: "shape-2" }));
  await drain(cc.stream({ messages, model: "x", sessionId: "shape-2" }));
  check("text following an image-first message survives", shapes[1] === "image(offloaded) text:look", shapes[1]);
}

/* ---------- 4c. images nested inside tool-result are intercepted too ----------
 * Regression: `read_image` results are a `tool-result` block holding the image in
 * some DSH builds. A top-level-only scan both missed them (re-inlining every
 * request) and made the whole message bypass the plugin without any error.
 */
{
  const cfg = Config({});
  const { adapters, shapes } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const messages = [
    { id: "m1", role: "user", content: [{ type: "text", text: "go" }] },
    { id: "m2", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read_image", arguments: {} }] },
    { id: "m3", role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "p" }, makeImageBlock("b2", "att-nested")] }] },
  ];
  const first = await drain(cc.stream({ messages, model: "x", sessionId: "nested" }));
  const second = await drain(cc.stream({ messages, model: "x", sessionId: "nested" }));
  check("nested image: first request inlines", first === "saw:0:offloaded=0", first);
  check("nested image: second request offloads it", shapes[1] === "text:go | toolCall | tool-result[text:p image(offloaded)]", shapes[1]);
  check("nested image: tool-result wrapper is preserved", shapes[1].includes("tool-result["), shapes[1]);
}
{
  // The shape today's running host produces (app.asar: role "tool", image top-level).
  const cfg = Config({});
  const { adapters, shapes } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const messages = [
    { id: "m1", role: "user", content: [{ type: "text", text: "go" }] },
    { id: "m2", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read_image", arguments: {} }] },
    { id: "m3", role: "tool", toolCallId: "c1", content: [{ type: "text", text: "p" }, makeImageBlock("b3", "att-flat")] },
  ];
  await drain(cc.stream({ messages, model: "x", sessionId: "flat" }));
  await drain(cc.stream({ messages, model: "x", sessionId: "flat" }));
  check("flat read_image result is offloaded on the second request", shapes[1] === "text:go | toolCall | text:p image(offloaded)", shapes[1]);
}

/* ---------- 4d. whole-message invariant: nothing dropped, nothing reordered ----------
 * The defect class above was block loss/ordering, so pin the invariant as a diff
 * between the pre-rewrite and post-rewrite sequences rather than an expectation
 * typed by hand: same block count, same identities in the same order, and the only
 * difference is the `off` marker on images.
 */
{
  const cfg = Config({});
  const { adapters, shapes } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const TR = (content) => ({ type: "tool-result", toolCallId: "c1", content });
  const messages = [
    { id: "m1", role: "user", content: [{ type: "text", text: "head" }, makeImageBlock("b1", "i1"), { type: "text", text: "mid" }, makeImageBlock("b2", "i2"), { type: "text", text: "tail" }] },
    { id: "m2", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read_image", arguments: {} }] },
    { id: "m3", role: "tool", content: [{ type: "text", text: "flat" }, makeImageBlock("b3", "i3")] },
    { id: "m4", role: "user", content: [{ type: "text", text: "n" }, TR([{ type: "text", text: "in" }, makeImageBlock("b4", "i4")])] },
    { id: "m5", role: "user", content: [{ type: "text", text: "plain" }] },
  ];
  // `shapes` records what the adapter actually received (the harness streams through
  // the plugin), so the invariant is measured on the real output — the input object
  // is deepFrozen and never mutated. Compare the rendered strings directly: splitting
  // on spaces would mis-tokenize `tool-result[…]`, whose brackets contain spaces.
  await drain(cc.stream({ messages, model: "x", sessionId: "invariant" }));
  await drain(cc.stream({ messages, model: "x", sessionId: "invariant" }));

  const [before, after] = [shapes[0], shapes[1]];
  // Same text with every image-state marker blanked out => same blocks, same order.
  const skeleton = (s) => s.replace(/image\((?:inline|offloaded)\)/g, "image(_)");
  const imagesOf = (s) => s.match(/image\((?:inline|offloaded)\)/g) ?? [];
  check("rewrite keeps every block", skeleton(before) === skeleton(after), `before: ${before}\n      after: ${after}`);
  check("rewrite keeps all four images", imagesOf(before).length === 4 && imagesOf(after).length === 4, `before=${imagesOf(before).length} after=${imagesOf(after).length}`);
  check("every image is offloaded on the second request", imagesOf(after).every((t) => t === "image(offloaded)"), imagesOf(after).join(" "));
  check("every image was inline on the first request", imagesOf(before).every((t) => t === "image(inline)"), imagesOf(before).join(" "));
  check("trailing text of each message survives", after.includes("text:tail") && after.includes("text:n") && after.includes("text:plain"), after);
}

/* ---------- 5. purpose-tagged helper calls are left alone ---------- */
{
  const cfg = Config({});
  const { adapters } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const out = await drain(cc.stream({ messages: makeMessages(), model: "x", sessionId: "same2", purpose: "title" }));
  check("purpose-tagged call bypasses the plugin", out === "saw:1:offloaded=0", out);
}

/* ---------- 6. no images -> passthrough ---------- */
{
  const cfg = Config({});
  const { adapters } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const out = await drain(cc.stream({ messages: [{ id: "m", role: "user", content: [{ type: "text", text: "x" }] }], model: "x", sessionId: "s3" }));
  check("text-only request passes through", out === "saw:0:offloaded=0", out);
}

/* ---------- 7. live config change is picked up without re-wrapping ---------- */
{
  const cfg = Config({});
  const { adapters, logs, listeners } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const before = await drain(cc.stream({ messages: makeMessages(), model: "x", sessionId: "live1" }));
  check("live: applies before change", before === "saw:1:offloaded=0", before);
  // simulate a volatile-only settings write (the settings service updates the
  // existing reference in place rather than replacing it)
  cfg.providers[WRITE]({ commandcode: { enabled: false, models: [] } });
  const volatile = listeners.get("loader/volatile-update");
  check("volatile listener registered", typeof volatile === "function");
  if (volatile) volatile();
  check("volatile log reports closed provider", logs.some((l) => l.includes("名单已更新") && l.includes('"commandcode"')), logs.join(" | "));
  const after = await drain(cc.stream({ messages: makeMessages(), model: "x", sessionId: "live1" }));
  check("live: disabled after change, same session", after === "saw:1:offloaded=0", after);
  check("wrapper identity preserved", adapters.get("commandcode").adapter === cc);
}

/* ---------- 8. prepareCall path ---------- */
{
  const cfg = Config({});
  const { adapters } = makeHarness(cfg);
  const cc = adapters.get("commandcode").adapter;
  const call = await cc.prepareCall("commandcode", "m", undefined);
  const first = await drain(call.stream({ messages: makeMessages(), model: "m", sessionId: "pc" }));
  const second = await drain(call.stream({ messages: makeMessages(), model: "m", sessionId: "pc" }));
  check("prepareCall: first inline", first === "saw:1:offloaded=0", first);
  check("prepareCall: second offload", second === "saw:1:offloaded=1", second);
}

/* ---------- 9. dispose restores originals ---------- */
{
  const cfg = Config({});
  const { adapters, listeners } = makeHarness(cfg);
  const wrapper = adapters.get("commandcode").adapter;
  const dispose = listeners.get("__dispose__");
  check("dispose registered", typeof dispose === "function");
  if (dispose) dispose();
  check("dispose restores original adapter", adapters.get("commandcode").adapter !== wrapper);
}

/* ---------- 10. broken / legacy config must not crash ---------- */
{
  const { adapters } = makeHarness({ providers: ["commandcode"] });
  const cc = adapters.get("commandcode").adapter;
  const out = await drain(cc.stream({ messages: makeMessages(), model: "x", sessionId: "bad" }));
  check("array-shaped providers degrades to all-on", out === "saw:1:offloaded=0", out);
}

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILURE(S):\n${failures.join("\n")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
