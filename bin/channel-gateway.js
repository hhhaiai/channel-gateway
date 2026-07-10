#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runChannelGateway } from "../src/launcher/run.js";

const serviceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

try {
  await runChannelGateway({ serviceRoot });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`channel-gateway: ${message.split(/\r?\n/, 1)[0]}\n`);
  process.exitCode = 1;
}
