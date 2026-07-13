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
    assert.match(runtime, /ctx\.ChatType/);
    assert.match(runtime, /chatType === "group" \|\| chatType === "channel"/);
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

    const markerPath = path.join(root, ".channel-gateway-rich-hook-v2.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(marker.packageVersion, "2026.6.11");
    assert.equal(marker.patchVersion, 2);
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

test("upgrades a trusted v1 marker to group-aware v2", async () => {
  await withFixture({}, async (root) => {
    await applyOpenClawRichHookPatch(root);
    const runtimePath = path.join(root, "dist", "dispatch-fixture.js");
    const runtime = await readFile(runtimePath, "utf8");
    const groupAware = 'hookContext.isGroup || chatType === "group" || chatType === "channel"';
    const legacyRuntime = runtime
      .replace(
        '\t\t\tconst chatType = typeof ctx.ChatType === "string" ? ctx.ChatType.trim().toLowerCase() : "";\n',
        "",
      )
      .replace(groupAware, "hookContext.isGroup");
    assert.notEqual(legacyRuntime, runtime);
    await writeFile(runtimePath, legacyRuntime);

    const v2MarkerPath = path.join(root, ".channel-gateway-rich-hook-v2.json");
    const v2Marker = JSON.parse(await readFile(v2MarkerPath, "utf8"));
    await rm(v2MarkerPath);
    const legacyFiles = { ...v2Marker.files };
    legacyFiles["dist/dispatch-fixture.js"] = createHash("sha256")
      .update(legacyRuntime)
      .digest("hex");
    await writeFile(
      path.join(root, ".channel-gateway-rich-hook-v1.json"),
      `${JSON.stringify({ patchVersion: 1, packageVersion: "2026.6.11", files: legacyFiles }, null, 2)}\n`,
    );

    const upgraded = await applyOpenClawRichHookPatch(root);
    assert.equal(upgraded.applied, true);
    assert.equal(upgraded.upgradedFrom, 1);
    assert.match(await readFile(runtimePath, "utf8"), new RegExp(groupAware.replace(/[|[\]{}()*+?.\\^$]/g, "\\$&")));
    assert.equal((await verifyOpenClawRichHookPatch(root)).verified, true);
    await assert.rejects(
      readFile(path.join(root, ".channel-gateway-rich-hook-v1.json")),
      { code: "ENOENT" },
    );
  });
});

test("recovers a v1 to v2 upgrade interrupted after the runtime write", async () => {
  await withFixture({}, async (root) => {
    await applyOpenClawRichHookPatch(root);
    const runtimePath = path.join(root, "dist", "dispatch-fixture.js");
    const upgradedRuntime = await readFile(runtimePath, "utf8");
    const groupAware = 'hookContext.isGroup || chatType === "group" || chatType === "channel"';
    const legacyRuntime = upgradedRuntime
      .replace(
        '\t\t\tconst chatType = typeof ctx.ChatType === "string" ? ctx.ChatType.trim().toLowerCase() : "";\n',
        "",
      )
      .replace(groupAware, "hookContext.isGroup");
    assert.notEqual(legacyRuntime, upgradedRuntime);

    const v2MarkerPath = path.join(root, ".channel-gateway-rich-hook-v2.json");
    const v2Marker = JSON.parse(await readFile(v2MarkerPath, "utf8"));
    await rm(v2MarkerPath);
    const legacyFiles = { ...v2Marker.files };
    legacyFiles["dist/dispatch-fixture.js"] = createHash("sha256")
      .update(legacyRuntime)
      .digest("hex");
    await writeFile(
      path.join(root, ".channel-gateway-rich-hook-v1.json"),
      `${JSON.stringify({ patchVersion: 1, packageVersion: "2026.6.11", files: legacyFiles }, null, 2)}\n`,
    );

    const recovered = await applyOpenClawRichHookPatch(root);
    assert.equal(recovered.applied, true);
    assert.equal(recovered.upgradedFrom, 1);
    assert.equal(await readFile(runtimePath, "utf8"), upgradedRuntime);
    assert.equal((await verifyOpenClawRichHookPatch(root)).verified, true);
    await assert.rejects(
      readFile(path.join(root, ".channel-gateway-rich-hook-v1.json")),
      { code: "ENOENT" },
    );
  });
});

test("rejects a tampered runtime while recovering an interrupted v1 upgrade", async () => {
  await withFixture({}, async (root) => {
    await applyOpenClawRichHookPatch(root);
    const runtimePath = path.join(root, "dist", "dispatch-fixture.js");
    const upgradedRuntime = await readFile(runtimePath, "utf8");
    const legacyRuntime = upgradedRuntime
      .replace(
        '\t\t\tconst chatType = typeof ctx.ChatType === "string" ? ctx.ChatType.trim().toLowerCase() : "";\n',
        "",
      )
      .replace(
        'hookContext.isGroup || chatType === "group" || chatType === "channel"',
        "hookContext.isGroup",
      );
    const v2MarkerPath = path.join(root, ".channel-gateway-rich-hook-v2.json");
    const v2Marker = JSON.parse(await readFile(v2MarkerPath, "utf8"));
    await rm(v2MarkerPath);
    await writeFile(
      path.join(root, ".channel-gateway-rich-hook-v1.json"),
      `${JSON.stringify({
        patchVersion: 1,
        packageVersion: "2026.6.11",
        files: {
          ...v2Marker.files,
          "dist/dispatch-fixture.js": createHash("sha256").update(legacyRuntime).digest("hex"),
        },
      }, null, 2)}\n`,
    );
    await writeFile(runtimePath, `${upgradedRuntime}\n// interrupted-state tamper\n`);

    await assert.rejects(
      applyOpenClawRichHookPatch(root),
      /hash mismatch for dist\/dispatch-fixture\.js/,
    );
  });
});

test("cleans a stale v1 marker after the v2 marker was committed", async () => {
  await withFixture({}, async (root) => {
    await applyOpenClawRichHookPatch(root);
    const legacyMarkerPath = path.join(root, ".channel-gateway-rich-hook-v1.json");
    await writeFile(legacyMarkerPath, "{}\n");

    assert.equal((await applyOpenClawRichHookPatch(root)).applied, false);
    await assert.rejects(readFile(legacyMarkerPath), { code: "ENOENT" });
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

    const markerPath = path.join(root, ".channel-gateway-rich-hook-v2.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.files["dist/dispatch-fixture.js"] = createHash("sha256").update(changed).digest("hex");
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

    await assert.rejects(
      verifyOpenClawRichHookPatch(root),
      /runtime patch postcondition failed/,
    );
  });
});
