import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOpenClawRichHookPatch,
  verifyOpenClawRichHookPatch,
} from "../src/host-patch.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(scriptDir, "..");
const openclawRoot = path.join(serviceRoot, "node_modules", "openclaw");
const args = process.argv.slice(2);

try {
  if (args.some((arg) => arg !== "--verify") || args.length > 1) {
    throw new Error("usage: node scripts/patch-openclaw-dist.mjs [--verify]");
  }
  const result = args[0] === "--verify"
    ? await verifyOpenClawRichHookPatch(openclawRoot)
    : await applyOpenClawRichHookPatch(openclawRoot);
  const action = args[0] === "--verify" ? "verified" : result.applied ? "applied" : "already applied";
  process.stdout.write(
    `OpenClaw rich before_dispatch patch ${action}: ${result.packageVersion} (${result.files.length} files)\n`,
  );
} catch (error) {
  process.stderr.write(`OpenClaw rich before_dispatch patch failed: ${error.message}\n`);
  process.exitCode = 1;
}
