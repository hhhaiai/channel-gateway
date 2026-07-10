import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureInitialConfig,
  resolveGatewaySettings,
} from "../src/launcher/config.js";

function packageDescriptor(id, rootDir) {
  return {
    id,
    name: `@openclaw/${id}`,
    version: "2026.6.11",
    rootDir,
  };
}

test("writes a private minimal no-LLM config that enables the bridge and discovered channels", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config", "openclaw.json");
  const serviceRoot = path.join(directory, "service");
  const discordRoot = path.join(serviceRoot, "node_modules", "@openclaw", "discord");
  const workspaceDir = path.join(directory, "workspace");
  const databasePath = path.join(directory, "state", "channel-gateway.sqlite");

  const result = await ensureInitialConfig({
    configPath,
    serviceRoot,
    workspaceDir,
    databasePath,
    channelPackages: [packageDescriptor("discord", discordRoot)],
    env: {},
  });

  const expected = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: 18789,
      auth: { mode: "token" },
      controlUi: { enabled: false },
      reload: { mode: "off" },
    },
    agents: { defaults: { workspace: workspaceDir, skipBootstrap: true } },
    plugins: {
      enabled: true,
      load: { paths: [serviceRoot, discordRoot] },
      entries: {
        "channel-gateway": {
          enabled: true,
          hooks: {
            allowConversationAccess: true,
            timeouts: { before_dispatch: 5000 },
          },
          config: { databasePath, links: [] },
        },
        discord: { enabled: true },
      },
    },
  };
  assert.deepEqual(result, { created: true, configPath, config: expected, port: 18789 });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), expected);
  assert.equal(await readFile(configPath, "utf8"), `${JSON.stringify(expected, null, 2)}\n`);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal("models" in expected, false);
});

test("enables the WhatsApp message-received hook and custom bind only when selected", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-whatsapp-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "openclaw.json");
  const whatsappRoot = path.join(directory, "whatsapp");

  const { config, port } = await ensureInitialConfig({
    configPath,
    serviceRoot: path.join(directory, "service"),
    workspaceDir: path.join(directory, "workspace"),
    databasePath: path.join(directory, "state", "channel-gateway.sqlite"),
    channelPackages: [packageDescriptor("whatsapp", whatsappRoot)],
    env: {
      CHANNEL_GATEWAY_BIND: "custom",
      CHANNEL_GATEWAY_CUSTOM_BIND_HOST: "127.0.0.2",
      CHANNEL_GATEWAY_PORT: "23456",
    },
  });

  assert.equal(port, 23456);
  assert.equal(config.gateway.bind, "custom");
  assert.equal(config.gateway.customBindHost, "127.0.0.2");
  assert.deepEqual(config.channels, {
    whatsapp: { pluginHooks: { messageReceived: true } },
  });
});

test("preserves every byte of an existing operator config", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-existing-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "openclaw.json");
  const serviceRoot = path.join(directory, "service");
  const workspaceDir = path.join(directory, "workspace");
  const databasePath = path.join(directory, "state", "channel-gateway.sqlite");
  const original = [
    "{",
    "  // operator-owned JSON5",
    "  gateway: {",
    "    mode: 'local',",
    "    port: 24567,",
    "    auth: { mode: 'token' },",
    "    controlUi: { enabled: false },",
    "    reload: { mode: 'off' },",
    "  },",
    `  agents: { defaults: { workspace: ${JSON.stringify(workspaceDir)}, skipBootstrap: true } },`,
    "  plugins: {",
    "    enabled: true,",
    `    load: { paths: [${JSON.stringify(serviceRoot)}] },`,
    "    entries: {",
    "      'channel-gateway': {",
    "        enabled: true,",
    "        hooks: { allowConversationAccess: true },",
    `        config: { databasePath: ${JSON.stringify(databasePath)}, links: [] },`,
    "      },",
    "    },",
    "  },",
    "}",
    "",
  ].join("\n");
  await writeFile(configPath, original, { mode: 0o640 });

  const result = await ensureInitialConfig({
    configPath,
    serviceRoot,
    workspaceDir,
    databasePath,
    channelPackages: [],
    env: {},
  });

  assert.deepEqual(result, { created: false, configPath, config: undefined, port: 24567 });
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("rejects an existing config that breaks isolated service invariants", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-existing-invariants-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "openclaw.json");
  const input = {
    configPath,
    serviceRoot: path.join(directory, "service"),
    workspaceDir: path.join(directory, "workspace"),
    databasePath: path.join(directory, "state", "channel-gateway.sqlite"),
    channelPackages: [],
    env: {},
  };
  const created = await ensureInitialConfig(input);
  const invalid = structuredClone(created.config);
  delete invalid.plugins.entries["channel-gateway"].config.databasePath;
  delete invalid.agents.defaults.skipBootstrap;
  delete invalid.gateway.controlUi;
  delete invalid.gateway.reload;
  await writeFile(configPath, `${JSON.stringify(invalid, null, 2)}\n`);

  await assert.rejects(
    () => ensureInitialConfig(input),
    /databasePath.*skipBootstrap.*controlUi.*reload/,
  );
});

test("fails fast when an existing config omits newly discovered channel packages", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-existing-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "openclaw.json");
  const serviceRoot = path.join(directory, "service");
  const baseInput = {
    configPath,
    serviceRoot,
    workspaceDir: path.join(directory, "workspace"),
    databasePath: path.join(directory, "state", "channel-gateway.sqlite"),
    env: {},
  };
  await ensureInitialConfig({ ...baseInput, channelPackages: [] });

  await assert.rejects(
    () => ensureInitialConfig({
      ...baseInput,
      channelPackages: [
        {
          id: "qqbot",
          rootDir: path.join(directory, "plugins", "qqbot"),
        },
      ],
    }),
    /existing config.*qqbot.*plugins\.load\.paths.*plugins\.entries/,
  );
});

test("validates bind, port, and custom host inputs", () => {
  assert.deepEqual(resolveGatewaySettings({}), { bind: "loopback", port: 18789 });
  for (const bind of ["", "public", "LOOPBACK"]) {
    assert.throws(
      () => resolveGatewaySettings({ CHANNEL_GATEWAY_BIND: bind }),
      /CHANNEL_GATEWAY_BIND must be one of/,
    );
  }
  for (const port of ["0", "65536", "1.5", "18789x", ""]) {
    assert.throws(
      () => resolveGatewaySettings({ CHANNEL_GATEWAY_PORT: port }),
      /CHANNEL_GATEWAY_PORT must be an integer between 1 and 65535/,
    );
  }
  assert.throws(
    () => resolveGatewaySettings({ CHANNEL_GATEWAY_BIND: "custom" }),
    /CHANNEL_GATEWAY_CUSTOM_BIND_HOST is required/,
  );
  assert.deepEqual(
    resolveGatewaySettings({
      CHANNEL_GATEWAY_BIND: "lan",
      CHANNEL_GATEWAY_CUSTOM_BIND_HOST: "ignored.example",
    }),
    { bind: "lan", port: 18789 },
  );
});

test("concurrent first-run writers never replace a completed config", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-config-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "openclaw.json");
  const input = {
    configPath,
    serviceRoot: path.join(directory, "service"),
    workspaceDir: path.join(directory, "workspace"),
    databasePath: path.join(directory, "state", "channel-gateway.sqlite"),
    channelPackages: [],
    env: {},
  };

  const results = await Promise.all([ensureInitialConfig(input), ensureInitialConfig(input)]);

  assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
  const createdConfig = results.find((result) => result.created).config;
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), createdConfig);
});

test("a first-run race loser validates the winner before continuing", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-config-race-loser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "openclaw.json");
  const qqRoot = path.join(directory, "plugins", "qqbot");

  await assert.rejects(
    () => ensureInitialConfig({
      configPath,
      serviceRoot: path.join(directory, "service"),
      workspaceDir: path.join(directory, "workspace"),
      databasePath: path.join(directory, "state", "channel-gateway.sqlite"),
      channelPackages: [{ id: "qqbot", rootDir: qqRoot }],
      env: {},
      async writeExclusive(filePath, contents) {
        const winner = JSON.parse(contents);
        winner.plugins.load.paths = winner.plugins.load.paths.filter((entry) => entry !== qqRoot);
        delete winner.plugins.entries.qqbot;
        await writeFile(filePath, `${JSON.stringify(winner, null, 2)}\n`);
        return false;
      },
    }),
    /existing config.*qqbot.*plugins\.load\.paths.*plugins\.entries/,
  );
});
