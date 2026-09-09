/**
 * File-based mutex for tests that share the `fixtures/minimal` build output.
 *
 * `node --test` runs each test file in a separate child process. Four test
 * suites (adapters, preview, parity, integration) all build into and clean
 * up the same `fixtures/minimal/dist` and `fixtures/minimal/.elur`
 * directories. Without coordination they race: one test deletes `dist/`
 * while another is mid-build, producing flaky "Cannot resolve entry module"
 * or "No build output found" errors.
 *
 * This module uses an exclusive file lock (O_EXCL create) to serialize only
 * the four suites that touch the shared fixture. The rest of the test
 * suite continues to run in parallel.
 *
 * Usage in a test file:
 *   import { acquireFixtureLock, releaseFixtureLock } from "../helpers/fixture-lock.js";
 *
 *   describe("my suite", () => {
 *     before(acquireFixtureLock);
 *     after(releaseFixtureLock);
 *   });
 */

import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_DIR = join(__dirname, "..", "fixtures", "minimal");
const LOCK_FILE = join(LOCK_DIR, ".test-lock");

const POLL_MS = 100;
const TIMEOUT_MS = 120_000; // 2 min — enough for the slowest adapter build

/**
 * Acquire an exclusive lock by creating LOCK_FILE with O_EXCL.
 * Retries every POLL_MS until the lock is acquired or TIMEOUT_MS elapses.
 */
export async function acquireFixtureLock(): Promise<void> {
  await mkdir(LOCK_DIR, { recursive: true });
  const deadline = Date.now() + TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(LOCK_FILE, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for fixture lock after ${TIMEOUT_MS}ms. ` +
          `Lock file: ${LOCK_FILE}`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

/**
 * Release the lock by deleting LOCK_FILE. Safe to call even if the lock
 * was never acquired (no-op if the file doesn't exist).
 */
export async function releaseFixtureLock(): Promise<void> {
  await rm(LOCK_FILE, { force: true });
}
