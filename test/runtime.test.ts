import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStaticFile } from "../src/runtime/static.ts";

describe("resolveStaticFile", () => {
  it("resolves files and clean URLs inside the static root", async () => {
    const root = await mkdtemp(join(tmpdir(), "elur-static-"));
    try {
      await mkdir(join(root, "about"));
      await writeFile(join(root, "about/index.html"), "about");
      assert.equal(await resolveStaticFile(root, "/about"), join(root, "about/index.html"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal, encoded traversal, backslashes and null bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "elur-static-"));
    try {
      for (const path of [
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/%252e%252e%252fsecret.txt",
        "/..\\secret.txt",
        "/%5csecret.txt",
        "/%00secret.txt",
      ]) {
        assert.equal(await resolveStaticFile(root, path), null, path);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks that escape the static root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "elur-static-"));
    const root = join(parent, "public");
    try {
      await mkdir(root);
      await writeFile(join(parent, "secret.txt"), "secret");
      await symlink(join(parent, "secret.txt"), join(root, "linked.txt"));
      assert.equal(await resolveStaticFile(root, "/linked.txt"), null);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
