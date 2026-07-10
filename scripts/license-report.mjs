#!/usr/bin/env node

import { lstat, realpath, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const result = {
    root: process.cwd(),
    output: undefined,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") {
      result.strict = true;
    } else if (argument === "--root" || argument === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      result[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  result.root = path.resolve(result.root);
  result.output = path.resolve(result.output ?? path.join(result.root, "artifacts/licenses.json"));
  return result;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function selectedPackagePath(sourcePath) {
  if (typeof sourcePath !== "string" || sourcePath === "") return false;
  const normalized = sourcePath.split("/").join(path.sep);
  return normalized === "node_modules" || normalized.startsWith(`node_modules${path.sep}`);
}

function normalizeLicense(metadata) {
  const candidate = metadata.license;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  if (Array.isArray(metadata.licenses)) {
    const values = metadata.licenses
      .map((entry) => typeof entry === "string" ? entry : entry?.type)
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
    if (values.length > 0) return values.join(" OR ");
  }
  return null;
}

function classify(license) {
  if (license === null || /^UNLICENSED$/i.test(license)) return "blocker";
  if (/(?:^|[^A-Z])(?:A?GPL|LGPL|MPL)(?:[^A-Z]|$)/i.test(license)) return "manual-review";
  return "allowed";
}

const CLASSIFICATION_RANK = Object.freeze({
  allowed: 0,
  "manual-review": 1,
  blocker: 2,
});

function stricterLicense(locked, installed) {
  const candidates = [normalizeLicense(locked), normalizeLicense(installed)]
    .map((license) => ({ license, classification: classify(license) }));
  return candidates.reduce((strictest, candidate) =>
    CLASSIFICATION_RANK[candidate.classification] > CLASSIFICATION_RANK[strictest.classification]
      ? candidate
      : strictest);
}

function supportsCurrentPlatform(osList) {
  if (!Array.isArray(osList) || osList.length === 0) return true;
  const values = osList.filter((value) => typeof value === "string");
  if (values.includes(`!${process.platform}`)) return false;
  const positive = values.filter((value) => !value.startsWith("!"));
  return positive.length === 0 || positive.includes(process.platform);
}

function missingLockedPackageIsAllowed(locked) {
  return locked.optional === true || locked.dev === true || locked.devOptional === true ||
    !supportsCurrentPlatform(locked.os);
}

export async function generateLicenseReport({ root, output }) {
  const rootReal = await realpath(root);
  const lock = JSON.parse(await readFile(path.join(rootReal, "package-lock.json"), "utf8"));
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock.json must contain a packages install tree");
  }

  const packages = [];
  for (const [sourcePath, locked] of Object.entries(lock.packages)) {
    if (!selectedPackagePath(sourcePath)) continue;
    const packageDirectory = path.resolve(rootReal, sourcePath);
    if (!inside(rootReal, packageDirectory)) {
      throw new Error(`locked package path escapes dependency root: ${sourcePath}`);
    }

    let packageEntry;
    try {
      packageEntry = await lstat(packageDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (missingLockedPackageIsAllowed(locked)) continue;
        throw new Error(`required locked package is missing: ${sourcePath}`);
      }
      throw error;
    }
    if (packageEntry.isSymbolicLink()) {
      throw new Error(`package directory must not be a symbolic link: ${sourcePath}`);
    }
    if (!packageEntry.isDirectory()) {
      throw new Error(`locked package path must be a directory: ${sourcePath}`);
    }

    let packageReal;
    let metadata;
    try {
      packageReal = await realpath(packageDirectory);
      if (!inside(rootReal, packageReal)) {
        throw new Error(`package directory resolves outside dependency root: ${sourcePath}`);
      }
      const packageJsonPath = path.join(packageReal, "package.json");
      const packageJsonEntry = await lstat(packageJsonPath);
      if (packageJsonEntry.isSymbolicLink()) {
        throw new Error(`package.json must not be a symbolic link: ${sourcePath}`);
      }
      metadata = JSON.parse(await readFile(packageJsonPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`installed package metadata is missing: ${sourcePath}`);
      }
      throw error;
    }

    const name = typeof metadata.name === "string" && metadata.name.trim()
      ? metadata.name.trim()
      : typeof locked.name === "string" && locked.name.trim()
        ? locked.name.trim()
        : path.basename(sourcePath);
    const version = typeof metadata.version === "string" && metadata.version.trim()
      ? metadata.version.trim()
      : typeof locked.version === "string" ? locked.version : null;
    const { license, classification } = stricterLicense(locked, metadata);
    packages.push({
      name,
      version,
      license,
      sourcePath: sourcePath.split(path.sep).join("/"),
      classification,
    });
  }

  packages.sort((left, right) =>
    left.name.localeCompare(right.name) || left.sourcePath.localeCompare(right.sourcePath));
  const blockers = packages.filter((entry) => entry.classification === "blocker");
  const manualReview = packages.filter((entry) => entry.classification === "manual-review");
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      total: packages.length,
      blockers: blockers.length,
      manualReview: manualReview.length,
    },
    packages,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  return { report, blockers, manualReview };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { report, blockers, manualReview } = await generateLicenseReport(options);
  process.stdout.write(
    `packages=${report.summary.total} blockers=${blockers.length} manual-review=${manualReview.length}\n`,
  );
  if (blockers.length > 0) {
    process.stdout.write(`blockers: ${[...new Set(blockers.map((entry) => entry.name))].sort().join(", ")}\n`);
  }
  if (manualReview.length > 0) {
    process.stdout.write(
      `manual-review: ${[...new Set(manualReview.map((entry) => entry.name))].sort().join(", ")}\n`,
    );
  }
  if (options.strict && blockers.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`license-report: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
