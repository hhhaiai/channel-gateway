import { discoverChannelPackages } from "./channel-packages.js";
import { ensureInitialConfig } from "./config.js";
import { ensureDataPaths, resolveDataPaths } from "./paths.js";
import {
  assertPinnedOpenClawInstallation,
  assertSupportedNodeVersion,
  superviseGateway,
} from "./process.js";
import { ensureGatewayToken } from "./token.js";

export async function runChannelGateway({
  serviceRoot,
  cwd = process.cwd(),
  env = process.env,
  nodeVersion = process.versions.node,
  processRef = process,
  spawn,
}) {
  assertSupportedNodeVersion(nodeVersion);
  await assertPinnedOpenClawInstallation({ serviceRoot });

  const paths = resolveDataPaths(env, cwd);
  await ensureDataPaths(paths);
  const channelPackages = await discoverChannelPackages({ serviceRoot, env });
  const config = await ensureInitialConfig({
    configPath: paths.configPath,
    serviceRoot,
    workspaceDir: paths.workspaceDir,
    databasePath: paths.databasePath,
    channelPackages,
    env,
  });
  const { token } = await ensureGatewayToken({
    env,
    credentialsDir: paths.credentialsDir,
  });

  return superviseGateway({
    serviceRoot,
    paths,
    token,
    port: config.port,
    env,
    processRef,
    ...(spawn ? { spawn } : {}),
  });
}
