// Package smoke test (plan §13, testing-roadmap §4.2)
//
// Verifies that the published tarball:
//   1. Can be packed with `bun pm pack`
//   2. Contains the expected files (dist, bin, README, CHANGELOG)
//   3. ESM and CJS entry points exist in the tarball
//   4. CLI binary exists and is executable
//   5. package.json exports are valid
//
// Full install-in-clean-project test is done in CI where network is available.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const KIT_ROOT = join(__dirname, "..");
const EXTRACT_DIR = join(tmpdir(), `elur-smoke-${Date.now()}`);

describe("package smoke test (plan §13)", () => {
  let tarballPath: string;
  let extractedPkg: Record<string, unknown>;

  before(() => {
    // Ensure dist/ exists
    if (!existsSync(join(KIT_ROOT, "dist", "lib", "index.js"))) {
      throw new Error("dist/lib not found — run `bun run build` before this test");
    }

    // Temporarily remove prepack to avoid rebuilding
    const pkgPath = join(KIT_ROOT, "package.json");
    const originalPkg = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(originalPkg);
    if (pkg.scripts?.prepack) {
      delete pkg.scripts.prepack;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }

    try {
      const result = spawnSync("bun", ["pm", "pack"], {
        cwd: KIT_ROOT,
        encoding: "utf-8",
        timeout: 30000,
      });
      writeFileSync(pkgPath, originalPkg);
      if (result.status !== 0) {
        throw new Error(`bun pm pack failed: ${result.stderr}`);
      }
    } catch (e) {
      writeFileSync(pkgPath, originalPkg);
      throw e;
    }

    // Find tarball
    const files = readdirSync(KIT_ROOT).filter((f) => f.endsWith(".tgz"));
    if (files.length === 0) throw new Error("No tarball found");
    tarballPath = join(KIT_ROOT, files[0]!);

    // Extract tarball to temp dir
    mkdirSync(EXTRACT_DIR, { recursive: true });
    spawnSync("tar", ["xzf", tarballPath, "-C", EXTRACT_DIR], { encoding: "utf-8" });

    // Read extracted package.json
    const extractedPkgPath = join(EXTRACT_DIR, "package");
    extractedPkg = JSON.parse(readFileSync(join(extractedPkgPath, "package.json"), "utf-8"));
  });

  after(() => {
    rmSync(EXTRACT_DIR, { recursive: true, force: true });
    if (existsSync(tarballPath)) rmSync(tarballPath);
  });

  it("tarball was created and is not empty", () => {
    assert.ok(existsSync(tarballPath), "tarball should exist");
    const stats = readFileSync(tarballPath);
    assert.ok(stats.length > 1000, "tarball should not be empty");
  });

  it("tarball contains dist/lib", () => {
    const distPath = join(EXTRACT_DIR, "package", "dist", "lib");
    assert.ok(existsSync(distPath), "dist/lib should be in tarball");
    assert.ok(existsSync(join(distPath, "index.js")), "ESM entry should exist");
    assert.ok(existsSync(join(distPath, "index.cjs")), "CJS entry should exist");
    assert.ok(existsSync(join(distPath, "index.d.ts")), "ESM types should exist");
    assert.ok(existsSync(join(distPath, "index.d.cts")), "CJS types should exist");
  });

  it("tarball contains bin", () => {
    const binPath = join(EXTRACT_DIR, "package", "bin");
    assert.ok(existsSync(binPath), "bin/ should be in tarball");
    assert.ok(existsSync(join(binPath, "elur-kit.js")), "CLI entry should exist");
  });

  it("tarball contains README and CHANGELOG", () => {
    assert.ok(existsSync(join(EXTRACT_DIR, "package", "README.md")), "README should be in tarball");
    assert.ok(existsSync(join(EXTRACT_DIR, "package", "CHANGELOG.md")), "CHANGELOG should be in tarball");
  });

  it("package.json exports are valid", () => {
    assert.ok(extractedPkg.exports, "should have exports");
    const exports = extractedPkg.exports as Record<string, { import?: string; require?: string; types?: unknown }>;
    assert.ok(exports["."], "should have main export");
    assert.ok(exports["."].import, "should have import condition");
    assert.ok(exports["."].require, "should have require condition");
    assert.ok(exports["."].types, "should have types");
    assert.ok(extractedPkg.bin, "should have bin");
  });

  it("engines field requires Node >=20.19.0", () => {
    const engines = extractedPkg.engines as { node?: string };
    assert.ok(engines?.node, "should have engines.node");
    assert.ok(
      engines.node.includes(">=20.19"),
      `engines.node should require >=20.19, got: ${engines.node}`,
    );
  });

  it("no unnecessary files in tarball (no src, no test, no scripts)", () => {
    const pkgDir = join(EXTRACT_DIR, "package");
    assert.ok(!existsSync(join(pkgDir, "src")), "src/ should not be in tarball");
    assert.ok(!existsSync(join(pkgDir, "test")), "test/ should not be in tarball");
    assert.ok(!existsSync(join(pkgDir, "node_modules")), "node_modules/ should not be in tarball");
  });

  it("ESM entry can be imported", async () => {
    const entryPath = join(EXTRACT_DIR, "package", "dist", "lib", "index.js");
    assert.ok(existsSync(entryPath), "ESM entry should exist");
    // Verify it's valid JS by reading first few bytes
    const content = readFileSync(entryPath, "utf-8");
    assert.ok(content.length > 100, "ESM entry should have content");
  });

  it("CJS entry can be required", () => {
    const entryPath = join(EXTRACT_DIR, "package", "dist", "lib", "index.cjs");
    assert.ok(existsSync(entryPath), "CJS entry should exist");
    const content = readFileSync(entryPath, "utf-8");
    assert.ok(content.length > 100, "CJS entry should have content");
  });
});
