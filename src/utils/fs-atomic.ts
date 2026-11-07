import { rename, rm } from "node:fs/promises";

/**
 * Renames a temporary file/directory into place.
 *
 * Windows can reject a rename with EPERM/EBUSY when the destination is
 * briefly locked by a concurrent writer or antivirus scanner. Retry a few
 * times, removing the destination before each attempt.
 */
export async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EEXIST") throw err;
      if (attempt === attempts - 1) throw err;
      await rm(to, { recursive: true, force: true }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}
