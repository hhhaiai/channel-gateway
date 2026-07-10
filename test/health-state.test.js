import assert from "node:assert/strict";
import test from "node:test";

import { HealthState } from "../src/health-state.js";

test("degrades without retaining message contents and recovers after a successful write", () => {
  const health = new HealthState({ now: () => 123 });

  health.degrade("SQLITE_FULL", new Error("secret message body"));

  assert.deepEqual(health.snapshot(), {
    status: "degraded",
    degradedAt: 123,
    code: "SQLITE_FULL",
  });
  assert.equal(JSON.stringify(health.snapshot()).includes("secret message body"), false);

  health.recover();
  assert.deepEqual(health.snapshot(), { status: "ok" });
});

test("validates controlled error codes and does not expose mutable state", () => {
  const health = new HealthState({ now: () => 456 });

  assert.throws(() => health.degrade("contains secret"), /controlled uppercase error code/);
  health.degrade("SQLITE_BUSY");
  const snapshot = health.snapshot();
  snapshot.code = "CHANGED";

  assert.equal(health.snapshot().code, "SQLITE_BUSY");
});
