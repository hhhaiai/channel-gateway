import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serviceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptPath = path.join(serviceRoot, "scripts", "license-report.mjs");

async function writePackage(root, packagePath, metadata) {
  const directory = path.join(root, packagePath);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify(metadata)}\n`);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "channel-gateway-licenses-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "channel-gateway-outside-"));
  await writePackage(root, "node_modules/allowed", {
    name: "allowed", version: "1.2.3", license: "MIT",
  });
  await writePackage(root, "node_modules/unlicensed", {
    name: "unlicensed", version: "2.0.0", license: "UNLICENSED",
  });
  await writePackage(root, "node_modules/missing", {
    name: "missing", version: "3.0.0",
  });
  await writePackage(root, "node_modules/gpl", {
    name: "gpl", version: "4.0.0", license: "GPL-3.0-only",
  });
  await writePackage(root, "node_modules/lgpl", {
    name: "lgpl", version: "5.0.0", license: "LGPL-2.1-or-later",
  });
  await writePackage(root, "node_modules/mpl", {
    name: "mpl", version: "6.0.0", license: "MPL-2.0",
  });
  await writePackage(outside, "escaped", {
    name: "outside-secret", version: "9.9.9", license: "UNLICENSED",
  });

  const packages = {
    "": { name: "fixture", version: "1.0.0" },
    "node_modules/allowed": { version: "1.2.3", license: "MIT" },
    "node_modules/unlicensed": { version: "2.0.0", license: "UNLICENSED" },
    "node_modules/missing": { version: "3.0.0" },
    "node_modules/gpl": { version: "4.0.0", license: "GPL-3.0-only" },
    "node_modules/lgpl": { version: "5.0.0", license: "LGPL-2.1-or-later" },
    "node_modules/mpl": { version: "6.0.0", license: "MPL-2.0" },
    [path.relative(root, path.join(outside, "escaped"))]: {
      name: "outside-secret", version: "9.9.9", license: "UNLICENSED",
    },
  };
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({
    name: "fixture", lockfileVersion: 3, packages,
  })}\n`);
  return { root, outside, output: path.join(root, "artifacts", "licenses.json") };
}

function run(root, output, strict = false) {
  return spawnSync(process.execPath, [
    scriptPath,
    "--root", root,
    "--output", output,
    ...(strict ? ["--strict"] : []),
  ], { encoding: "utf8" });
}

test("reports installed locked packages with blocker and manual-review classifications", async (t) => {
  const { root, outside, output } = await fixture();
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const result = run(root, output);
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(await readFile(output, "utf8"));
  const byName = new Map(report.packages.map((entry) => [entry.name, entry]));
  assert.deepEqual(
    { name: byName.get("allowed").name, version: byName.get("allowed").version,
      license: byName.get("allowed").license, sourcePath: byName.get("allowed").sourcePath },
    { name: "allowed", version: "1.2.3", license: "MIT", sourcePath: "node_modules/allowed" },
  );
  assert.equal(byName.get("unlicensed").classification, "blocker");
  assert.equal(byName.get("missing").classification, "blocker");
  assert.equal(byName.get("missing").license, null);
  assert.equal(byName.get("gpl").classification, "manual-review");
  assert.equal(byName.get("lgpl").classification, "manual-review");
  assert.equal(byName.get("mpl").classification, "manual-review");
  assert.equal(byName.has("outside-secret"), false);
  assert.deepEqual(report.summary, { total: 6, blockers: 2, manualReview: 3 });
  assert.match(result.stdout, /packages=6 blockers=2 manual-review=3/);
  assert.equal(result.stdout.includes(root), false);
});

test("strict mode exits nonzero only when blockers exist", async (t) => {
  const blocked = await fixture();
  t.after(() => Promise.all([
    rm(blocked.root, { recursive: true, force: true }),
    rm(blocked.outside, { recursive: true, force: true }),
  ]));
  const blockedResult = run(blocked.root, blocked.output, true);
  assert.equal(blockedResult.status, 1);
  assert.match(blockedResult.stdout, /blockers: missing, unlicensed/);

  const reviewOnly = await mkdtemp(path.join(os.tmpdir(), "channel-gateway-review-"));
  t.after(() => rm(reviewOnly, { recursive: true, force: true }));
  await writePackage(reviewOnly, "node_modules/review", {
    name: "review", version: "1.0.0", license: "MPL-2.0",
  });
  await writeFile(path.join(reviewOnly, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "review-fixture", version: "1.0.0" },
      "node_modules/review": { version: "1.0.0", license: "MPL-2.0" },
    },
  }));
  const reviewResult = run(reviewOnly, path.join(reviewOnly, "licenses.json"), true);
  assert.equal(reviewResult.status, 0, reviewResult.stderr);
  assert.match(reviewResult.stdout, /manual-review: review/);
});
