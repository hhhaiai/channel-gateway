import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPENCLAW_VERSION,
  discoverChannelPackages,
} from "../src/launcher/channel-packages.js";

async function writePackage(rootDir, options) {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({
      name: options.name,
      version: options.version ?? OPENCLAW_VERSION,
      openclaw: {
        channel: { id: options.packageChannelId ?? options.id },
        ...(options.minHostVersion
          ? { install: { minHostVersion: options.minHostVersion } }
          : {}),
        ...(options.pluginApi ? { compat: { pluginApi: options.pluginApi } } : {}),
      },
    })}\n`,
  );
  await writeFile(
    path.join(rootDir, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: options.id,
      channels: options.channels ?? [options.id],
      configSchema: { type: "object", properties: {} },
    })}\n`,
  );
}

function builtInRoot(serviceRoot, name) {
  return path.join(serviceRoot, "node_modules", "@openclaw", name);
}

test("discovers only installed exact-version official channel packages", async (t) => {
  const serviceRoot = await mkdtemp(path.join(tmpdir(), "channel-gateway-packages-"));
  t.after(() => rm(serviceRoot, { recursive: true, force: true }));
  const discordRoot = builtInRoot(serviceRoot, "discord");
  const slackRoot = builtInRoot(serviceRoot, "slack");
  await writePackage(discordRoot, { name: "@openclaw/discord", id: "discord" });
  await writePackage(slackRoot, { name: "@openclaw/slack", id: "slack" });

  assert.deepEqual(await discoverChannelPackages({ serviceRoot, env: {} }), [
    {
      id: "discord",
      name: "@openclaw/discord",
      version: OPENCLAW_VERSION,
      rootDir: discordRoot,
    },
    {
      id: "slack",
      name: "@openclaw/slack",
      version: OPENCLAW_VERSION,
      rootDir: slackRoot,
    },
  ]);
});

test("rejects installed official packages with a mismatched version or channel id", async (t) => {
  const serviceRoot = await mkdtemp(path.join(tmpdir(), "channel-gateway-package-mismatch-"));
  t.after(() => rm(serviceRoot, { recursive: true, force: true }));
  const discordRoot = builtInRoot(serviceRoot, "discord");
  await writePackage(discordRoot, {
    name: "@openclaw/discord",
    id: "discord",
    version: "2026.6.10",
  });

  await assert.rejects(
    () => discoverChannelPackages({ serviceRoot, env: {} }),
    /@openclaw\/discord must be exactly 2026\.6\.11/,
  );

  await writePackage(discordRoot, {
    name: "@openclaw/discord",
    id: "not-discord",
    packageChannelId: "not-discord",
  });
  await assert.rejects(
    () => discoverChannelPackages({ serviceRoot, env: {} }),
    /expected channel id discord/,
  );
});

test("discovers every installed official package, including QQ", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-official-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const serviceRoot = path.join(directory, "service");
  const qqRoot = builtInRoot(serviceRoot, "qqbot");
  const signalRoot = builtInRoot(serviceRoot, "signal");
  await writePackage(qqRoot, { name: "@openclaw/qqbot", id: "qqbot" });
  await writePackage(signalRoot, { name: "@openclaw/signal", id: "signal" });

  assert.deepEqual(await discoverChannelPackages({ serviceRoot, env: {} }), [
    { id: "qqbot", name: "@openclaw/qqbot", version: OPENCLAW_VERSION, rootDir: qqRoot },
    { id: "signal", name: "@openclaw/signal", version: OPENCLAW_VERSION, rootDir: signalRoot },
  ]);
});

test("validates every explicit plugin path and manifest", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-explicit-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const serviceRoot = path.join(directory, "service");
  const firstRoot = path.join(directory, "plugins", "first");
  const secondRoot = path.join(directory, "plugins", "second");
  await writePackage(firstRoot, { name: "example-first", id: "first" });
  await writePackage(secondRoot, { name: "example-second", id: "second" });

  assert.deepEqual(
    await discoverChannelPackages({
      serviceRoot,
      env: { CHANNEL_GATEWAY_PLUGIN_PATHS: [firstRoot, secondRoot].join(path.delimiter) },
    }),
    [
      { id: "first", name: "example-first", version: OPENCLAW_VERSION, rootDir: firstRoot },
      { id: "second", name: "example-second", version: OPENCLAW_VERSION, rootDir: secondRoot },
    ],
  );

  await assert.rejects(
    () =>
      discoverChannelPackages({
        serviceRoot,
        env: { CHANNEL_GATEWAY_PLUGIN_PATHS: "relative/plugin" },
      }),
    /plugin paths must be absolute/,
  );

  await writePackage(secondRoot, {
    name: "example-second",
    id: "second",
    channels: ["different"],
  });
  await assert.rejects(
    () =>
      discoverChannelPackages({
        serviceRoot,
        env: { CHANNEL_GATEWAY_PLUGIN_PATHS: secondRoot },
      }),
    /manifest must declare channel id second/,
  );
});
