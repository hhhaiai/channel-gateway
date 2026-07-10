import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("fails closed when a required locked package is missing from the install tree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "channel-gateway-missing-required-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "missing-required-fixture", version: "1.0.0" },
      "node_modules/required": { version: "1.0.0", license: "MIT" },
      "node_modules/optional": { version: "1.0.0", license: "MIT", optional: true },
      "node_modules/dev-only": { version: "1.0.0", license: "MIT", dev: true },
      "node_modules/other-platform": {
        version: "1.0.0",
        license: "MIT",
        os: [process.platform === "linux" ? "darwin" : "linux"],
      },
    },
  }));

  const result = run(root, path.join(root, "licenses.json"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required locked package is missing: node_modules\/required/);
  assert.doesNotMatch(result.stderr, /optional|dev-only|other-platform/);
});

test("rejects a package-directory symlink even when it stays inside the selected root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "channel-gateway-symlink-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePackage(root, "packages/shared", {
    name: "shared", version: "1.0.0", license: "MIT",
  });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await symlink(path.join(root, "packages/shared"), path.join(root, "node_modules/shared"));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "symlink-fixture", version: "1.0.0" },
      "node_modules/shared": { version: "1.0.0", license: "MIT" },
    },
  }));

  const result = run(root, path.join(root, "licenses.json"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package directory must not be a symbolic link: node_modules\/shared/);
});

test("uses the stricter classification across lock and installed metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "channel-gateway-license-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePackage(root, "node_modules/conflict", {
    name: "conflict", version: "1.0.0", license: "MIT",
  });
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "conflict-fixture", version: "1.0.0" },
      "node_modules/conflict": { version: "1.0.0", license: "UNLICENSED" },
    },
  }));

  const result = run(root, path.join(root, "licenses.json"));
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(path.join(root, "licenses.json"), "utf8"));
  assert.equal(report.packages[0].license, "UNLICENSED");
  assert.equal(report.packages[0].classification, "blocker");
});
