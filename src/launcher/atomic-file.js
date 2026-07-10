import { link, open, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function writePrivateFileExclusive(filePath, contents, options = {}) {
  const mode = options.mode ?? 0o600;
  const createSuffix = options.createSuffix ?? randomUUID;
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${createSuffix()}.tmp`,
  );
  let handle;

  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;

    try {
      await link(temporaryPath, filePath);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
}
