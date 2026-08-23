import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

// Fix #5: happy-dom as optional peer dependency

describe("Fix #5: happy-dom optional peer dependency", () => {
  it("happy-dom is NOT in dependencies", () => {
    assert.ok(
      !pkg.dependencies || !("happy-dom" in pkg.dependencies),
      "happy-dom must not be in dependencies (it's not a runtime dep)",
    );
  });

  it("happy-dom is in peerDependenciesMeta with optional: true", () => {
    assert.ok(
      pkg.peerDependenciesMeta && pkg.peerDependenciesMeta["happy-dom"],
      "happy-dom must be in peerDependenciesMeta",
    );
    assert.equal(
      pkg.peerDependenciesMeta["happy-dom"].optional,
      true,
      "happy-dom must be marked optional: true",
    );
  });
});
