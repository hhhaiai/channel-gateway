import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the project test script excludes tests inside the upstream submodule", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(
    packageJson.scripts.test,
    "node --test --test-concurrency=1 'test/**/*.test.js'",
  );
});
