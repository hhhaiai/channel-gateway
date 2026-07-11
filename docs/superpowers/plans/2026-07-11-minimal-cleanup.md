# Minimal Cleanup Plan

## Scope

Only three previously audited, behavior-preserving simplifications:

1. Delete the unreferenced `OPENCLAW_RICH_HOOK_PATCH` export from `src/host-patch.js`.
2. Remove the redundant `deliveryId` alias from the public delivery summary in `src/event-store.js` while preserving the marker-relation DTO field.
3. Remove unused API construction aliases (`rpcInput`, `gatewayRpc`, `eventStream`) from `src/api-handler.js`.

## Behavior locks

- Host patch: `test/host-patch.test.js`, `npm run verify:openclaw-patch`.
- Delivery summary/outbox: `test/delivery-outbox.test.js`, `test/delivery-worker.test.js`, `test/four-endpoint-integration.test.js`.
- API construction: `test/api-handler.test.js`, `test/bridge-runtime.test.js`, standalone smoke.

## Pass order

1. Add narrow regression assertions that define the reduced public shapes and constructor contract; run them red.
2. Delete dead export.
3. Remove the duplicate delivery summary field without changing marker relations.
4. Simplify the API constructor signature.
5. Run targeted tests after each pass, then full test/check/patch/smoke gates.

## Explicit non-goals

- Do not abstract or deduplicate the pinned Host patch literals.
- Do not alter EventStore retention ordering, Bridge ingress ordering, or launcher config race checks.
- Do not add dependencies or change public HTTP API behavior.
