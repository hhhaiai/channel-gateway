import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectories = ["bin", "src", "scripts", "test"];

async function collectJavaScriptFiles(directory) {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(path)));
    } else if (entry.isFile() && extname(entry.name) === ".js") {
      files.push(path);
    }
  }

  return files;
}

for (const sourceDirectory of sourceDirectories) {
  const files = await collectJavaScriptFiles(join(rootDirectory, sourceDirectory));

  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

await import(pathToFileURL(join(rootDirectory, "index.js")).href);
