import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPENCLAW_VERSION,
  discoverChannelPackages,
} from "../src/launcher/channel-packages.js";

const WECOM_PLUGIN_VERSION = "2026.5.25";

async function writePackage(rootDir, options) {
  const pluginId = options.pluginId ?? options.id;
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
      id: pluginId,
      channels: options.channels ?? [options.id],
      configSchema: { type: "object", properties: {} },
    })}\n`,
  );
}

function builtInRoot(serviceRoot, name) {
  return path.join(serviceRoot, "node_modules", "@openclaw", name);
}

function wecomRoot(serviceRoot) {
  return path.join(serviceRoot, "node_modules", "@wecom", "wecom-openclaw-plugin");
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
      pluginId: "discord",
      channelIds: ["discord"],
      name: "@openclaw/discord",
      version: OPENCLAW_VERSION,
      rootDir: discordRoot,
    },
    {
      pluginId: "slack",
      channelIds: ["slack"],
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
    pluginId: "discord",
    packageChannelId: "not-discord",
  });
  await assert.rejects(
    () => discoverChannelPackages({ serviceRoot, env: {} }),
    /expected channel id discord/,
  );

  await writePackage(discordRoot, {
    name: "@openclaw/discord",
    id: "discord",
    pluginId: "renamed-discord",
  });
  await assert.rejects(
    () => discoverChannelPackages({ serviceRoot, env: {} }),
    /expected plugin id discord/,
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
    { pluginId: "qqbot", channelIds: ["qqbot"], name: "@openclaw/qqbot", version: OPENCLAW_VERSION, rootDir: qqRoot },
    { pluginId: "signal", channelIds: ["signal"], name: "@openclaw/signal", version: OPENCLAW_VERSION, rootDir: signalRoot },
  ]);
});

test("discovers an external plugin whose plugin id differs from its channel id", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-wecom-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const serviceRoot = path.join(directory, "service");
  const wecomRoot = path.join(directory, "plugins", "wecom");
  await writePackage(wecomRoot, {
    name: "@wecom/wecom-openclaw-plugin",
    id: "wecom",
    pluginId: "wecom-openclaw-plugin",
    packageChannelId: "wecom",
    channels: ["wecom"],
    minHostVersion: ">=2026.3.28",
  });

  assert.deepEqual(
    await discoverChannelPackages({
      serviceRoot,
      env: { CHANNEL_GATEWAY_PLUGIN_PATHS: wecomRoot },
    }),
    [{
      pluginId: "wecom-openclaw-plugin",
      channelIds: ["wecom"],
      name: "@wecom/wecom-openclaw-plugin",
      version: OPENCLAW_VERSION,
      rootDir: wecomRoot,
    }],
  );
});

test("auto-discovers only the pinned WeCom plugin release", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-pinned-wecom-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const serviceRoot = path.join(directory, "service");
  const rootDir = wecomRoot(serviceRoot);
  const options = {
    name: "@wecom/wecom-openclaw-plugin",
    id: "wecom",
    pluginId: "wecom-openclaw-plugin",
    packageChannelId: "wecom",
    channels: ["wecom"],
    minHostVersion: ">=2026.3.28",
  };
  await writePackage(rootDir, { ...options, version: WECOM_PLUGIN_VERSION });

  assert.deepEqual(await discoverChannelPackages({ serviceRoot, env: {} }), [{
    pluginId: "wecom-openclaw-plugin",
    channelIds: ["wecom"],
    name: "@wecom/wecom-openclaw-plugin",
    version: WECOM_PLUGIN_VERSION,
    rootDir,
    existingConfigOptional: true,
  }]);

  await writePackage(rootDir, { ...options, version: "2026.6.23" });
  await assert.rejects(
    () => discoverChannelPackages({ serviceRoot, env: {} }),
    /@wecom\/wecom-openclaw-plugin must be exactly 2026\.5\.25/,
  );

  await writePackage(rootDir, {
    ...options,
    pluginId: "renamed-wecom-plugin",
    version: WECOM_PLUGIN_VERSION,
  });
  await assert.rejects(
    () => discoverChannelPackages({ serviceRoot, env: {} }),
    /expected plugin id wecom-openclaw-plugin/,
  );
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
      { pluginId: "first", channelIds: ["first"], name: "example-first", version: OPENCLAW_VERSION, rootDir: firstRoot },
      { pluginId: "second", channelIds: ["second"], name: "example-second", version: OPENCLAW_VERSION, rootDir: secondRoot },
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

  await writePackage(secondRoot, {
    name: "example-second",
    id: "second",
    channels: ["second", "SECOND"],
  });
  await assert.rejects(
    () =>
      discoverChannelPackages({
        serviceRoot,
        env: { CHANNEL_GATEWAY_PLUGIN_PATHS: secondRoot },
      }),
    /manifest channel ids must be unique/,
  );
});

test("rejects duplicate plugin ids and duplicate channel ownership", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-duplicate-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const serviceRoot = path.join(directory, "service");
  const firstRoot = path.join(directory, "plugins", "first");
  const secondRoot = path.join(directory, "plugins", "second");
  await writePackage(firstRoot, { name: "example-first", id: "first" });
  await writePackage(secondRoot, {
    name: "example-second",
    id: "second",
    pluginId: "first",
  });

  await assert.rejects(
    () => discoverChannelPackages({
      serviceRoot,
      env: { CHANNEL_GATEWAY_PLUGIN_PATHS: [firstRoot, secondRoot].join(path.delimiter) },
    }),
    /plugin id first is provided by multiple plugin paths/,
  );

  await writePackage(secondRoot, {
    name: "example-second",
    id: "second",
    pluginId: "second",
    channels: ["first"],
    packageChannelId: "first",
  });
  await assert.rejects(
    () => discoverChannelPackages({
      serviceRoot,
      env: { CHANNEL_GATEWAY_PLUGIN_PATHS: [firstRoot, secondRoot].join(path.delimiter) },
    }),
    /channel id first is provided by multiple plugin paths/,
  );

  await writePackage(secondRoot, {
    name: "example-second",
    id: "second",
    pluginId: "FIRST",
  });
  await assert.rejects(
    () => discoverChannelPackages({
      serviceRoot,
      env: { CHANNEL_GATEWAY_PLUGIN_PATHS: [firstRoot, secondRoot].join(path.delimiter) },
    }),
    /plugin id FIRST conflicts with first/,
  );

  await writePackage(secondRoot, {
    name: "example-second",
    id: "second",
    pluginId: "second",
    channels: ["FIRST"],
    packageChannelId: "FIRST",
  });
  await assert.rejects(
    () => discoverChannelPackages({
      serviceRoot,
      env: { CHANNEL_GATEWAY_PLUGIN_PATHS: [firstRoot, secondRoot].join(path.delimiter) },
    }),
    /channel id FIRST conflicts with first/,
  );
});

test("rejects an external plugin that claims the reserved bridge id", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-reserved-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const serviceRoot = path.join(directory, "service");
  const rootDir = path.join(directory, "plugins", "reserved");
  await writePackage(rootDir, {
    name: "example-reserved",
    id: "reserved-channel",
    pluginId: "channel-gateway",
  });

  await assert.rejects(
    () => discoverChannelPackages({
      serviceRoot,
      env: { CHANNEL_GATEWAY_PLUGIN_PATHS: rootDir },
    }),
    /plugin id channel-gateway is reserved/,
  );
});
