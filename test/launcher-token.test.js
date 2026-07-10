import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureGatewayToken } from "../src/launcher/token.js";

test("atomically generates and reuses a private gateway token file", async (t) => {
  const credentialsDir = await mkdtemp(path.join(tmpdir(), "channel-gateway-token-"));
  t.after(() => rm(credentialsDir, { recursive: true, force: true }));

  const first = await ensureGatewayToken({
    env: {},
    credentialsDir,
    randomBytes: () => Buffer.alloc(32, 7),
  });

  assert.equal(first.token, "07".repeat(32));
  assert.equal(first.source, "generated");
  assert.equal(first.path, path.join(credentialsDir, "gateway-token"));
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.equal(await readFile(first.path, "utf8"), `${first.token}\n`);
  assert.deepEqual(await readdir(credentialsDir), ["gateway-token"]);

  const second = await ensureGatewayToken({ env: {}, credentialsDir });
  assert.deepEqual(second, { ...first, source: "file" });
});

test("uses a non-blank environment token without persisting it", async (t) => {
  const credentialsDir = await mkdtemp(path.join(tmpdir(), "channel-gateway-env-token-"));
  t.after(() => rm(credentialsDir, { recursive: true, force: true }));

  const result = await ensureGatewayToken({
    env: { CHANNEL_GATEWAY_TOKEN: "  env-token  " },
    credentialsDir,
  });

  assert.deepEqual(result, {
    token: "env-token",
    source: "environment",
    path: path.join(credentialsDir, "gateway-token"),
  });
  assert.deepEqual(await readdir(credentialsDir), []);
  await assert.rejects(
    () => ensureGatewayToken({ env: { CHANNEL_GATEWAY_TOKEN: "  " }, credentialsDir }),
    /CHANNEL_GATEWAY_TOKEN must not be blank/,
  );
});

test("reads an existing token without changing its bytes and tightens its mode", async (t) => {
  const credentialsDir = await mkdtemp(path.join(tmpdir(), "channel-gateway-file-token-"));
  t.after(() => rm(credentialsDir, { recursive: true, force: true }));
  const tokenPath = path.join(credentialsDir, "gateway-token");
  await writeFile(tokenPath, "file-token\n", { mode: 0o644 });

  const result = await ensureGatewayToken({ env: {}, credentialsDir });

  assert.deepEqual(result, { token: "file-token", source: "file", path: tokenPath });
  assert.equal(await readFile(tokenPath, "utf8"), "file-token\n");
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
});

test("rejects a blank persisted token instead of silently replacing it", async (t) => {
  const credentialsDir = await mkdtemp(path.join(tmpdir(), "channel-gateway-blank-token-"));
  t.after(() => rm(credentialsDir, { recursive: true, force: true }));
  await writeFile(path.join(credentialsDir, "gateway-token"), " \n", { mode: 0o600 });

  await assert.rejects(
    () => ensureGatewayToken({ env: {}, credentialsDir }),
    /stored gateway token must not be blank/,
  );
});

test("refuses to read or chmod a gateway token through a symbolic link", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-token-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentialsDir = path.join(directory, "credentials");
  const victimPath = path.join(directory, "victim-token");
  await writeFile(victimPath, "victim-secret\n", { mode: 0o644 });
  await mkdir(credentialsDir);
  await symlink(victimPath, path.join(credentialsDir, "gateway-token"), "file");

  await assert.rejects(
    () => ensureGatewayToken({ env: {}, credentialsDir }),
    /gateway token must be a regular file and must not be a symbolic link/,
  );
  assert.equal((await stat(victimPath)).mode & 0o777, 0o644);
});
