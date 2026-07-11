import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as hostPatch from "../src/host-patch.js";

const {
  applyOpenClawRichHookPatch,
  verifyOpenClawRichHookPatch,
} = hostPatch;

const RUNTIME_DECLARATION = `\tconst hookContext = deriveInboundMessageHookContext(ctx, { messageId: messageIdForHook });
\tconst { isGroup, groupId } = hookContext;
\tconst inboundClaimContext = toPluginInboundClaimContext(hookContext);
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

test("exposes only the Host patch operations", () => {
  assert.equal("OPENCLAW_RICH_HOOK_PATCH" in hostPatch, false);
});

async function createFixture({
  version = "2026.6.11",
  runtimeDeclaration = RUNTIME_DECLARATION,
  beforeDispatchCall = BEFORE_DISPATCH_CALL,
  typeSurfaces = 2,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "channel-gateway-host-patch-"));
  await mkdir(path.join(root, "dist", "plugin-sdk"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "openclaw", version }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "dist", "dispatch-fixture.js"),
    `async function fixture() {\n${runtimeDeclaration}\n${beforeDispatchCall}\n}\n`,
  );
  const typePaths = [
    path.join(root, "dist", "hook-types-fixture.d.ts"),
    path.join(root, "dist", "plugin-sdk", "hook-types-fixture.d.ts"),
    path.join(root, "dist", "hook-types-extra.d.ts"),
  ];
  for (let index = 0; index < typeSurfaces; index += 1) {
    await writeFile(typePaths[index], `${TYPE_DECLARATIONS}\n`);
  }
  return root;
}

async function withFixture(options, callback) {
  const root = await createFixture(options);
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("rejects OpenClaw versions other than the pinned release", async () => {
  await withFixture({ version: "2026.6.10" }, async (root) => {
    await assert.rejects(
      applyOpenClawRichHookPatch(root),
      /requires openclaw 2026\.6\.11; found 2026\.6\.10/,
    );
  });
});

test("requires exactly one runtime hook-context declaration marker", async (t) => {
  await t.test("rejects zero matches", async () => {
    await withFixture({ runtimeDeclaration: "\tconst unrelated = true;" }, async (root) => {
      await assert.rejects(
        applyOpenClawRichHookPatch(root),
        /hook-context declaration: expected exactly 1 match, found 0/,
      );
    });
  });
  await t.test("rejects multiple matches", async () => {
    await withFixture(
      { runtimeDeclaration: `${RUNTIME_DECLARATION}\n${RUNTIME_DECLARATION}` },
      async (root) => {
        await assert.rejects(
          applyOpenClawRichHookPatch(root),
          /hook-context declaration: expected exactly 1 match, found 2/,
        );
      },
    );
  });
});

test("requires exactly one before_dispatch call-site marker", async (t) => {
  await t.test("rejects zero matches", async () => {
    await withFixture({ beforeDispatchCall: "\t\treturn undefined;" }, async (root) => {
      await assert.rejects(
        applyOpenClawRichHookPatch(root),
        /before_dispatch call site: expected exactly 1 match, found 0/,
      );
    });
  });
  await t.test("rejects multiple matches", async () => {
    await withFixture(
      { beforeDispatchCall: `${BEFORE_DISPATCH_CALL}\n${BEFORE_DISPATCH_CALL}` },
      async (root) => {
        await assert.rejects(
          applyOpenClawRichHookPatch(root),
          /before_dispatch call site: expected exactly 1 match, found 2/,
        );
      },
    );
  });
});

test("requires exactly two published hook declaration surfaces", async (t) => {
  await t.test("rejects a missing surface", async () => {
    await withFixture({ typeSurfaces: 1 }, async (root) => {
      await assert.rejects(
        applyOpenClawRichHookPatch(root),
        /before_dispatch declarations: expected exactly 2 matches, found 1/,
      );
    });
  });
  await t.test("rejects an unexpected extra surface", async () => {
    await withFixture({ typeSurfaces: 3 }, async (root) => {
      await assert.rejects(
        applyOpenClawRichHookPatch(root),
        /before_dispatch declarations: expected exactly 2 matches, found 3/,
      );
    });
  });
});

test("patches rich canonical fields, remote staging, declarations, and a hash marker", async () => {
  await withFixture({}, async (root) => {
    const result = await applyOpenClawRichHookPatch(root);
    assert.equal(result.applied, true);

    const runtimePath = path.join(root, "dist", "dispatch-fixture.js");
    const runtime = await readFile(runtimePath, "utf8");
    assert.match(runtime, /let hookContext = deriveInboundMessageHookContext/);
    assert.match(runtime, /let inboundClaimContext = toPluginInboundClaimContext/);
    assert.match(runtime, /import\("\.\/stage-sandbox-media\.runtime\.js"\)/);
    assert.ok(
      runtime.indexOf('if (hookRunner?.hasHooks("before_dispatch"))') <
        runtime.indexOf('import("./stage-sandbox-media.runtime.js")'),
      "remote media staging must only run when the awaited hook exists",
    );
    assert.match(
      runtime,
      /stageSandboxMedia\(\{ ctx, sessionCtx: ctx, cfg, sessionKey: acpDispatchSessionKey, workspaceDir \}\)/,
    );
    assert.match(runtime, /ctx\.MediaStaged = true/);
    assert.match(runtime, /stagedMedia\.staged\.size === 0/);
    assert.match(runtime, /hookContext = deriveInboundMessageHookContext/);
    assert.match(runtime, /inboundClaimContext = toPluginInboundClaimContext/);
    assert.match(
      runtime,
      /remoteMediaPaths = Array\.isArray\(ctx\.MediaPaths\) && ctx\.MediaPaths\.length > 0/,
    );
    assert.match(runtime, /originalRemoteMediaReferences/);
    assert.match(runtime, /restoreRemoteMediaReferences/);
    assert.match(runtime, /mediaStagingError = true/);
    assert.doesNotMatch(runtime, /mediaStagingError:\s*(?:String|formatErrorMessage)/);

    for (const field of [
      "accountId",
      "conversationId",
      "senderName",
      "senderUsername",
      "threadId",
      "messageId",
      "mediaPaths",
      "mediaUrls",
      "mediaTypes",
      "metadata",
    ]) {
      assert.match(runtime, new RegExp(`\\b${field}:`), `missing runtime field ${field}`);
    }
    assert.match(runtime, /mediaStagingError/);
    assert.match(runtime, /from: hookContext\.from/);
    assert.match(runtime, /provider: hookContext\.provider/);

    for (const relativePath of [
      path.join("dist", "hook-types-fixture.d.ts"),
      path.join("dist", "plugin-sdk", "hook-types-fixture.d.ts"),
    ]) {
      const declarations = await readFile(path.join(root, relativePath), "utf8");
      for (const declaration of [
        "accountId?: string;",
        "conversationId?: string;",
        "senderName?: string;",
        "senderUsername?: string;",
        "threadId?: string | number;",
        "messageId?: string;",
        "mediaPaths?: string[];",
        "mediaUrls?: string[];",
        "mediaTypes?: string[];",
        "metadata?: Record<string, unknown>;",
      ]) {
        assert.match(declarations, new RegExp(declaration.replace(/[|[\]{}()*+?.\\^$]/g, "\\$&")));
      }
    }

    const markerPath = path.join(root, ".channel-gateway-rich-hook-v1.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(marker.packageVersion, "2026.6.11");
    assert.equal(marker.patchVersion, 1);
    assert.deepEqual(Object.keys(marker.files).sort(), [
      "dist/dispatch-fixture.js",
      "dist/hook-types-fixture.d.ts",
      "dist/plugin-sdk/hook-types-fixture.d.ts",
    ]);
    for (const [relativePath, expectedHash] of Object.entries(marker.files)) {
      const bytes = await readFile(path.join(root, relativePath));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash);
    }

    assert.equal((await applyOpenClawRichHookPatch(root)).applied, false);
    assert.equal((await verifyOpenClawRichHookPatch(root)).verified, true);

    await writeFile(runtimePath, `${runtime}\n// tampered\n`);
    await assert.rejects(
      verifyOpenClawRichHookPatch(root),
      /hash mismatch for dist\/dispatch-fixture\.js/,
    );
    await assert.rejects(
      applyOpenClawRichHookPatch(root),
      /hash mismatch for dist\/dispatch-fixture\.js/,
    );
  });
});

test("does not trust a rehashed marker when patched runtime content changed", async () => {
  await withFixture({}, async (root) => {
    await applyOpenClawRichHookPatch(root);
    const runtimePath = path.join(root, "dist", "dispatch-fixture.js");
    const runtime = await readFile(runtimePath, "utf8");
    const changed = runtime.replace("ctx.MediaStaged = true;", "ctx.MediaStaged = false;");
    assert.notEqual(changed, runtime);
    await writeFile(runtimePath, changed);

    const markerPath = path.join(root, ".channel-gateway-rich-hook-v1.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.files["dist/dispatch-fixture.js"] = createHash("sha256").update(changed).digest("hex");
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

    await assert.rejects(
      verifyOpenClawRichHookPatch(root),
      /runtime patch postcondition failed/,
    );
  });
});
