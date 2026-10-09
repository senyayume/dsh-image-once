// Run both specs in one process:
//   - host.mjs   drives apply(ctx, config) against a stub cordis context and a
//                stub llm registry, asserting the whitelist semantics.
//   - client.mjs loads the real client bundle through a minimal
//                __ModuleLoader__ host with a tiny React shim.
//
//   node test/run.mjs
//
// `node --test` is not used: the specs are plain modules that set process.exitCode.
// The host half imports `@deepseek-ai/schemastery` (a declared peer), which only
// resolves because this package carries a dev junction at
// node_modules/@deepseek-ai/schemastery -> the profile's installed copy.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const peer = join(here, "..", "node_modules", "@deepseek-ai", "schemastery");
if (!existsSync(peer)) {
  throw new Error(
    `missing dev peer at ${peer}; create it with:\n` +
      `  New-Item -ItemType Junction -Path "${peer}" -Target "<profile>/node_modules/@deepseek-ai/schemastery"`,
  );
}

await import("./host.mjs");
await import("./client.mjs");

if (process.exitCode) console.log("\ndsh-image-once: spec(s) failed");
