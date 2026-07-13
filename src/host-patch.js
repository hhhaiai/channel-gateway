import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPPORTED_OPENCLAW_VERSION = "2026.6.11";
const PATCH_VERSION = 2;
const MARKER_FILE = ".channel-gateway-rich-hook-v2.json";
const LEGACY_PATCH_VERSION = 1;
const LEGACY_MARKER_FILE = ".channel-gateway-rich-hook-v1.json";

const RUNTIME_DECLARATION = `\tconst hookContext = deriveInboundMessageHookContext(ctx, { messageId: messageIdForHook });
\tconst { isGroup, groupId } = hookContext;
\tconst inboundClaimContext = toPluginInboundClaimContext(hookContext);
\tconst inboundClaimEvent = toPluginInboundClaimEvent(hookContext, {
\t\tcommandAuthorized: typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : void 0,
\t\twasMentioned: typeof ctx.WasMentioned === "boolean" ? ctx.WasMentioned : void 0
\t});`;

const PATCHED_RUNTIME_DECLARATION = `\tlet hookContext = deriveInboundMessageHookContext(ctx, { messageId: messageIdForHook });
\tconst { isGroup, groupId } = hookContext;
\tlet inboundClaimContext = toPluginInboundClaimContext(hookContext);
\tconst inboundClaimEvent = toPluginInboundClaimEvent(hookContext, {
\t\tcommandAuthorized: typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : void 0,
\t\twasMentioned: typeof ctx.WasMentioned === "boolean" ? ctx.WasMentioned : void 0
\t});`;

const BEFORE_DISPATCH_CALL = `\t\tif (hookRunner?.hasHooks("before_dispatch")) {
\t\t\tconst beforeDispatchResult = await traceReplyPhase("reply.before_dispatch_hooks", () => runWithDispatchAbortSignal(getPreDispatchAbortSignal(), () => hookRunner.runBeforeDispatch({
\t\t\t\tcontent: hookContext.content,
\t\t\t\tbody: hookContext.bodyForAgent ?? hookContext.body,
\t\t\t\tchannel: hookContext.channelId,
\t\t\t\tsessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
\t\t\t\tsenderId: hookContext.senderId,
\t\t\t\treplyToId: hookContext.replyToId,
\t\t\t\treplyToIdFull: hookContext.replyToIdFull,
\t\t\t\treplyToBody: hookContext.replyToBody,
\t\t\t\treplyToSender: hookContext.replyToSender,
\t\t\t\treplyToIsQuote: hookContext.replyToIsQuote,
\t\t\t\tisGroup: hookContext.isGroup,
\t\t\t\ttimestamp: hookContext.timestamp
\t\t\t}, {
\t\t\t\tchannelId: hookContext.channelId,
\t\t\t\taccountId: hookContext.accountId,
\t\t\t\tconversationId: inboundClaimContext.conversationId,
\t\t\t\tsessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
\t\t\t\tsenderId: hookContext.senderId,
\t\t\t\treplyToId: hookContext.replyToId,
\t\t\t\treplyToIdFull: hookContext.replyToIdFull,
\t\t\t\treplyToBody: hookContext.replyToBody,
\t\t\t\treplyToSender: hookContext.replyToSender,
\t\t\t\treplyToIsQuote: hookContext.replyToIsQuote
\t\t\t})));`;

const LEGACY_PATCHED_BEFORE_DISPATCH_CALL = `\t\tif (hookRunner?.hasHooks("before_dispatch")) {
\t\t\tlet mediaStagingError = false;
\t\t\tconst remoteMediaPaths = Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0 ? ctx.MediaPaths : ctx.MediaPath ? [ctx.MediaPath] : [];
\t\t\tif (ctx.MediaRemoteHost && remoteMediaPaths.length > 0) {
\t\t\t\tconst originalRemoteMediaReferences = {
\t\t\t\t\tMediaPath: ctx.MediaPath,
\t\t\t\t\tMediaPaths: Array.isArray(ctx.MediaPaths) ? [...ctx.MediaPaths] : ctx.MediaPaths,
\t\t\t\t\tMediaUrl: ctx.MediaUrl,
\t\t\t\t\tMediaUrls: Array.isArray(ctx.MediaUrls) ? [...ctx.MediaUrls] : ctx.MediaUrls,
\t\t\t\t\tMediaType: ctx.MediaType,
\t\t\t\t\tMediaTypes: Array.isArray(ctx.MediaTypes) ? [...ctx.MediaTypes] : ctx.MediaTypes,
\t\t\t\t\tMediaStaged: ctx.MediaStaged
\t\t\t\t};
\t\t\t\tconst restoreRemoteMediaReferences = () => {
\t\t\t\t\tctx.MediaPath = originalRemoteMediaReferences.MediaPath;
\t\t\t\t\tctx.MediaPaths = originalRemoteMediaReferences.MediaPaths;
\t\t\t\t\tctx.MediaUrl = originalRemoteMediaReferences.MediaUrl;
\t\t\t\t\tctx.MediaUrls = originalRemoteMediaReferences.MediaUrls;
\t\t\t\t\tctx.MediaType = originalRemoteMediaReferences.MediaType;
\t\t\t\t\tctx.MediaTypes = originalRemoteMediaReferences.MediaTypes;
\t\t\t\t\tctx.MediaStaged = originalRemoteMediaReferences.MediaStaged;
\t\t\t\t};
\t\t\t\ttry {
\t\t\t\t\tconst { stageSandboxMedia } = await import("./stage-sandbox-media.runtime.js");
\t\t\t\t\tconst stagedMedia = await stageSandboxMedia({ ctx, sessionCtx: ctx, cfg, sessionKey: acpDispatchSessionKey, workspaceDir });
\t\t\t\t\tif (stagedMedia.staged.size === 0) {
\t\t\t\t\t\trestoreRemoteMediaReferences();
\t\t\t\t\t\tmediaStagingError = true;
\t\t\t\t\t} else {
\t\t\t\t\t\tctx.MediaStaged = true;
\t\t\t\t\t\thookContext = deriveInboundMessageHookContext(ctx, { messageId: messageIdForHook });
\t\t\t\t\t\tinboundClaimContext = toPluginInboundClaimContext(hookContext);
\t\t\t\t\t}
\t\t\t\t} catch {
\t\t\t\t\trestoreRemoteMediaReferences();
\t\t\t\t\tmediaStagingError = true;
\t\t\t\t}
\t\t\t}
\t\t\tconst beforeDispatchMetadata = {
\t\t\t\tfrom: hookContext.from,
\t\t\t\tto: hookContext.to,
\t\t\t\tprovider: hookContext.provider,
\t\t\t\tsurface: hookContext.surface,
\t\t\t\toriginatingChannel: hookContext.originatingChannel,
\t\t\t\toriginatingTo: hookContext.originatingTo,
\t\t\t\tmediaPath: hookContext.mediaPath,
\t\t\t\tmediaUrl: hookContext.mediaUrl,
\t\t\t\tmediaType: hookContext.mediaType,
\t\t\t\tmediaStagingError
\t\t\t};
\t\t\tconst beforeDispatchResult = await traceReplyPhase("reply.before_dispatch_hooks", () => runWithDispatchAbortSignal(getPreDispatchAbortSignal(), () => hookRunner.runBeforeDispatch({
\t\t\t\tcontent: hookContext.content,
\t\t\t\tbody: hookContext.bodyForAgent ?? hookContext.body,
\t\t\t\tchannel: hookContext.channelId,
\t\t\t\taccountId: hookContext.accountId,
\t\t\t\tconversationId: inboundClaimContext.conversationId,
\t\t\t\tsessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
\t\t\t\tmessageId: hookContext.messageId,
\t\t\t\tsenderId: hookContext.senderId,
\t\t\t\tsenderName: hookContext.senderName,
\t\t\t\tsenderUsername: hookContext.senderUsername,
\t\t\t\tthreadId: hookContext.threadId,
\t\t\t\treplyToId: hookContext.replyToId,
\t\t\t\treplyToIdFull: hookContext.replyToIdFull,
\t\t\t\treplyToBody: hookContext.replyToBody,
\t\t\t\treplyToSender: hookContext.replyToSender,
\t\t\t\treplyToIsQuote: hookContext.replyToIsQuote,
\t\t\t\tmediaPaths: hookContext.mediaPaths,
\t\t\t\tmediaUrls: hookContext.mediaUrls,
\t\t\t\tmediaTypes: hookContext.mediaTypes,
\t\t\t\tisGroup: hookContext.isGroup,
\t\t\t\ttimestamp: hookContext.timestamp,
\t\t\t\tmetadata: beforeDispatchMetadata
\t\t\t}, {
\t\t\t\tchannelId: hookContext.channelId,
\t\t\t\taccountId: hookContext.accountId,
\t\t\t\tconversationId: inboundClaimContext.conversationId,
\t\t\t\tsessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
\t\t\t\tmessageId: hookContext.messageId,
\t\t\t\tsenderId: hookContext.senderId,
\t\t\t\tsenderName: hookContext.senderName,
\t\t\t\tsenderUsername: hookContext.senderUsername,
\t\t\t\tthreadId: hookContext.threadId,
\t\t\t\treplyToId: hookContext.replyToId,
\t\t\t\treplyToIdFull: hookContext.replyToIdFull,
\t\t\t\treplyToBody: hookContext.replyToBody,
\t\t\t\treplyToSender: hookContext.replyToSender,
\t\t\t\treplyToIsQuote: hookContext.replyToIsQuote,
\t\t\t\tmediaPaths: hookContext.mediaPaths,
\t\t\t\tmediaUrls: hookContext.mediaUrls,
\t\t\t\tmediaTypes: hookContext.mediaTypes,
\t\t\t\tmetadata: beforeDispatchMetadata
\t\t\t})));`;

const PATCHED_BEFORE_DISPATCH_CALL = LEGACY_PATCHED_BEFORE_DISPATCH_CALL
  .replace(
    "\t\t\tconst beforeDispatchMetadata = {",
    `\t\t\tconst chatType = typeof ctx.ChatType === "string" ? ctx.ChatType.trim().toLowerCase() : "";
\t\t\tconst beforeDispatchMetadata = {`,
  )
  .replace(
    "\t\t\t\tisGroup: hookContext.isGroup,",
    `\t\t\t\tisGroup: hookContext.isGroup || chatType === "group" || chatType === "channel",`,
  );

const TYPE_DECLARATIONS = `type PluginHookBeforeDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  isGroup?: boolean;
  timestamp?: number;
};
type PluginHookBeforeDispatchContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  senderId?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
};`;

const PATCHED_TYPE_DECLARATIONS = `type PluginHookBeforeDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  threadId?: string | number;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  mediaPaths?: string[];
  mediaUrls?: string[];
  mediaTypes?: string[];
  isGroup?: boolean;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};
type PluginHookBeforeDispatchContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  threadId?: string | number;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  mediaPaths?: string[];
  mediaUrls?: string[];
  mediaTypes?: string[];
  metadata?: Record<string, unknown>;
};`;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function countExact(source, marker) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(marker, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + marker.length;
  }
}

function toPosixRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function readPackageVersion(root) {
  const packagePath = path.join(root, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`unable to read OpenClaw package metadata at ${packagePath}: ${error.message}`);
  }
  if (manifest.version !== SUPPORTED_OPENCLAW_VERSION) {
    throw new Error(
      `rich hook patch requires openclaw ${SUPPORTED_OPENCLAW_VERSION}; found ${String(manifest.version)}`,
    );
  }
  return manifest.version;
}

async function listRuntimeFiles(root) {
  const distDir = path.join(root, "dist");
  const entries = await readdir(distDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(distDir, entry.name))
    .sort();
}

async function listHookTypeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listHookTypeFiles(entryPath)));
    } else if (entry.isFile() && entry.name.includes("hook-types") && entry.name.endsWith(".d.ts")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

async function findExactMatches(files, marker) {
  const matches = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    const count = countExact(source, marker);
    if (count > 0) matches.push({ filePath, source, count });
  }
  return matches;
}

function requireCount(label, matches, expected) {
  const count = matches.reduce((total, match) => total + match.count, 0);
  if (count !== expected) {
    throw new Error(`${label}: expected exactly ${expected} match${expected === 1 ? "" : "es"}, found ${count}`);
  }
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${suffix}.tmp`);
  await writeFile(tempPath, content);
  await rename(tempPath, filePath);
}

async function buildMarker(root, packageVersion, changedFiles) {
  const files = {};
  for (const filePath of [...changedFiles].sort()) {
    const relativePath = toPosixRelative(root, filePath);
    files[relativePath] = sha256(await readFile(filePath));
  }
  return {
    patchVersion: PATCH_VERSION,
    packageVersion,
    files,
  };
}

async function readMarker(root, markerFile = MARKER_FILE) {
  const markerPath = path.join(root, markerFile);
  try {
    return JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`unable to read rich hook patch marker: ${error.message}`);
  }
}

function validateMarkerShape(marker, patchVersion = PATCH_VERSION) {
  if (
    marker === null ||
    typeof marker !== "object" ||
    marker.patchVersion !== patchVersion ||
    marker.packageVersion !== SUPPORTED_OPENCLAW_VERSION ||
    marker.files === null ||
    typeof marker.files !== "object" ||
    Array.isArray(marker.files)
  ) {
    throw new Error("invalid rich hook patch marker");
  }
  const entries = Object.entries(marker.files);
  if (entries.length !== 3) throw new Error(`invalid rich hook patch marker file count: ${entries.length}`);
  for (const [relativePath, hash] of entries) {
    if (
      path.isAbsolute(relativePath) ||
      relativePath.split("/").includes("..") ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash)
    ) {
      throw new Error(`invalid rich hook patch marker entry: ${relativePath}`);
    }
  }
  return entries;
}

async function verifiedMarkerFiles(root, marker, patchVersion = PATCH_VERSION) {
  const entries = validateMarkerShape(marker, patchVersion);
  const verifiedFiles = [];
  for (const [relativePath, expectedHash] of entries) {
    let bytes;
    try {
      bytes = await readFile(path.join(root, ...relativePath.split("/")));
    } catch (error) {
      throw new Error(`unable to verify ${relativePath}: ${error.message}`);
    }
    const actualHash = sha256(bytes);
    if (actualHash !== expectedHash) throw new Error(`hash mismatch for ${relativePath}`);
    verifiedFiles.push({ relativePath, source: bytes.toString("utf8") });
  }
  return { entries, verifiedFiles };
}

async function verifiedLegacyMarkerFiles(root, marker) {
  const entries = validateMarkerShape(marker, LEGACY_PATCH_VERSION);
  const verifiedFiles = [];
  let runtimeAlreadyUpgraded = false;
  for (const [relativePath, expectedHash] of entries) {
    let bytes;
    try {
      bytes = await readFile(path.join(root, ...relativePath.split("/")));
    } catch (error) {
      throw new Error(`unable to verify ${relativePath}: ${error.message}`);
    }
    const source = bytes.toString("utf8");
    if (sha256(bytes) !== expectedHash) {
      const restoredLegacySource = relativePath.endsWith(".js") &&
        countExact(source, PATCHED_BEFORE_DISPATCH_CALL) === 1
        ? source.replace(PATCHED_BEFORE_DISPATCH_CALL, LEGACY_PATCHED_BEFORE_DISPATCH_CALL)
        : undefined;
      if (restoredLegacySource === undefined || sha256(restoredLegacySource) !== expectedHash) {
        throw new Error(`hash mismatch for ${relativePath}`);
      }
      runtimeAlreadyUpgraded = true;
    }
    verifiedFiles.push({ relativePath, source });
  }
  return { entries, verifiedFiles, runtimeAlreadyUpgraded };
}

function assertPatchedFiles(verifiedFiles, beforeDispatchCall) {
  const runtimeFiles = verifiedFiles.filter(({ relativePath }) => relativePath.endsWith(".js"));
  const declarationFiles = verifiedFiles.filter(({ relativePath }) => relativePath.endsWith(".d.ts"));
  if (
    runtimeFiles.length !== 1 ||
    countExact(runtimeFiles[0].source, PATCHED_RUNTIME_DECLARATION) !== 1 ||
    countExact(runtimeFiles[0].source, beforeDispatchCall) !== 1 ||
    countExact(runtimeFiles[0].source, RUNTIME_DECLARATION) !== 0 ||
    countExact(runtimeFiles[0].source, BEFORE_DISPATCH_CALL) !== 0
  ) {
    throw new Error("runtime patch postcondition failed");
  }
  if (
    declarationFiles.length !== 2 ||
    declarationFiles.some(
      ({ source }) =>
        countExact(source, PATCHED_TYPE_DECLARATIONS) !== 1 ||
        countExact(source, TYPE_DECLARATIONS) !== 0,
    )
  ) {
    throw new Error("declaration patch postcondition failed");
  }
  return runtimeFiles[0];
}

export async function verifyOpenClawRichHookPatch(root) {
  const packageVersion = await readPackageVersion(root);
  const marker = await readMarker(root);
  if (!marker) throw new Error(`missing ${MARKER_FILE}`);
  const { entries, verifiedFiles } = await verifiedMarkerFiles(root, marker);
  assertPatchedFiles(verifiedFiles, PATCHED_BEFORE_DISPATCH_CALL);
  return {
    verified: true,
    packageVersion,
    markerPath: path.join(root, MARKER_FILE),
    files: entries.map(([relativePath]) => relativePath),
  };
}

export async function applyOpenClawRichHookPatch(root) {
  const packageVersion = await readPackageVersion(root);
  if (await readMarker(root)) {
    const verification = await verifyOpenClawRichHookPatch(root);
    await rm(path.join(root, LEGACY_MARKER_FILE), { force: true });
    return { ...verification, applied: false };
  }

  const legacyMarker = await readMarker(root, LEGACY_MARKER_FILE);
  if (legacyMarker) {
    const { entries, verifiedFiles, runtimeAlreadyUpgraded } =
      await verifiedLegacyMarkerFiles(root, legacyMarker);
    const runtimeFile = assertPatchedFiles(
      verifiedFiles,
      runtimeAlreadyUpgraded ? PATCHED_BEFORE_DISPATCH_CALL : LEGACY_PATCHED_BEFORE_DISPATCH_CALL,
    );
    const upgradedRuntime = runtimeAlreadyUpgraded
      ? runtimeFile.source
      : runtimeFile.source.replace(LEGACY_PATCHED_BEFORE_DISPATCH_CALL, PATCHED_BEFORE_DISPATCH_CALL);
    if (countExact(upgradedRuntime, PATCHED_BEFORE_DISPATCH_CALL) !== 1) {
      throw new Error("runtime patch upgrade postcondition failed");
    }
    const runtimePath = path.join(root, ...runtimeFile.relativePath.split("/"));
    if (!runtimeAlreadyUpgraded) await atomicWrite(runtimePath, upgradedRuntime);
    const marker = await buildMarker(
      root,
      packageVersion,
      entries.map(([relativePath]) => path.join(root, ...relativePath.split("/"))),
    );
    await atomicWrite(path.join(root, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
    await rm(path.join(root, LEGACY_MARKER_FILE), { force: true });
    const verification = await verifyOpenClawRichHookPatch(root);
    return { ...verification, applied: true, upgradedFrom: LEGACY_PATCH_VERSION };
  }

  const runtimeFiles = await listRuntimeFiles(root);
  const declarationMatches = await findExactMatches(runtimeFiles, RUNTIME_DECLARATION);
  requireCount("hook-context declaration", declarationMatches, 1);
  const callMatches = await findExactMatches(runtimeFiles, BEFORE_DISPATCH_CALL);
  requireCount("before_dispatch call site", callMatches, 1);
  if (declarationMatches[0].filePath !== callMatches[0].filePath) {
    throw new Error("runtime markers resolved to different files");
  }

  const hookTypeFiles = await listHookTypeFiles(path.join(root, "dist"));
  const typeMatches = await findExactMatches(hookTypeFiles, TYPE_DECLARATIONS);
  requireCount("before_dispatch declarations", typeMatches, 2);
  if (typeMatches.length !== 2 || typeMatches.some((match) => match.count !== 1)) {
    throw new Error("before_dispatch declarations must occur once in each of two files");
  }

  const runtimePath = declarationMatches[0].filePath;
  const runtimeSource = declarationMatches[0].source;
  const runtimePatched = runtimeSource
    .replace(RUNTIME_DECLARATION, PATCHED_RUNTIME_DECLARATION)
    .replace(BEFORE_DISPATCH_CALL, PATCHED_BEFORE_DISPATCH_CALL);
  if (
    countExact(runtimePatched, PATCHED_RUNTIME_DECLARATION) !== 1 ||
    countExact(runtimePatched, PATCHED_BEFORE_DISPATCH_CALL) !== 1
  ) {
    throw new Error("runtime patch postcondition failed");
  }

  const writes = [
    [runtimePath, runtimePatched],
    ...typeMatches.map(({ filePath, source }) => [
      filePath,
      source.replace(TYPE_DECLARATIONS, PATCHED_TYPE_DECLARATIONS),
    ]),
  ];
  for (const [filePath, content] of writes) await atomicWrite(filePath, content);

  const marker = await buildMarker(
    root,
    packageVersion,
    writes.map(([filePath]) => filePath),
  );
  const markerPath = path.join(root, MARKER_FILE);
  await atomicWrite(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  const verification = await verifyOpenClawRichHookPatch(root);
  return { ...verification, applied: true };
}
