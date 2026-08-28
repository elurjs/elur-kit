#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const here = dirname(fileURLToPath(import.meta.url));

// Bun projects can use `bun:` protocol imports (bun:sqlite, etc.). When the
// bin is spawned through node (e.g. `bun run build` -> sh -> `env node`),
// those imports cannot be resolved, so re-exec with the Bun runtime when the
// project is bun-managed (bun.lock present).
if (
  !process.versions.bun &&
  (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb")))
) {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (probe.status === 0) {
    const result = spawnSync("bun", [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
    });
    process.exit(result.status ?? 1);
  }
}

// Register tsx so dynamic imports of user .ts pages/islands work at runtime
// under Node. Bun transpiles TypeScript natively and does not need it.
if (!process.versions.bun) {
  const tsx = await import("tsx/esm/api").catch(() => null);
  if (tsx) tsx.register();
}

const built = join(here, "../dist/lib/cli.js");

if (!existsSync(built)) {
  console.log("[elur-kit] dist/lib/cli.js not found, running npm run build:lib...");
  const result = spawnSync("npm", ["run", "build:lib"], {
    stdio: "inherit",
    cwd: join(here, ".."),
  });
  if (result.status !== 0) {
    console.error("[elur-kit] build:lib failed");
    process.exit(result.status ?? 1);
  }
}

const { run } = await import(built);

run(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
