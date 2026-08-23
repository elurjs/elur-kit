import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { transformPartialInterpolations } from "../src/vite/interpolation-plugin.ts";
import {
  coreSupportsPartialInterpolation,
  shouldUseLegacyInterpolation,
} from "../src/vite/interpolation-plugin.ts";
import { transformProjectFiles } from "../src/build/transform-source.ts";
import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, redirect, isActionFailure, isRedirectResponse } from "../src/errors.ts";

describe("nixJsInterpolationPlugin transform", () => {
  it("converts partial attribute interpolation to single interpolation", () => {
    const source = 'html' + '`<a href="/blog/${slug}">Post</a>`;';
    const result = transformPartialInterpolations(source);
    assert.ok(result.includes('href=${"/blog/" + (slug)}'), result);
  });

  it("handles multiple interpolations in one attribute", () => {
    const source = 'html' + '`<a href="/blog/${slug}/${id}">Post</a>`;';
    const result = transformPartialInterpolations(source);
    assert.ok(result.includes('href=${"/blog/" + (slug) + "/" + (id)}'), result);
  });

  it("leaves static attributes unchanged", () => {
    const source = 'html' + '`<a href="/blog/hello">Post</a>`;';
    const result = transformPartialInterpolations(source);
    assert.equal(result, source);
  });

  it("handles interpolations with nested braces and function calls", () => {
    const source = 'html' + '`<div title="tag ${cls({ active: true })}">x</div>`;';
    const result = transformPartialInterpolations(source);
    assert.ok(result.includes('title=${"tag " + (cls({ active: true }))}'), result);
  });

  it("leaves full-value quoted interpolations untouched", () => {
    const source = 'html' + '`<time datetime="${createdAt}">x</time>`;';
    const result = transformPartialInterpolations(source);
    assert.equal(result, source);
  });

  it("leaves unquoted interpolations untouched", () => {
    const source = 'html' + '`<input value=${() => name.value} />`;';
    const result = transformPartialInterpolations(source);
    assert.equal(result, source);
  });

  it("handles interpolations in single-quoted attributes", () => {
    const source = "html`<div data-x='/blog/${slug}'>x</div>`;";
    const result = transformPartialInterpolations(source);
    assert.ok(result.includes(`data-x=\${"/blog/" + (slug)}`), result);
  });

  it("does not corrupt text interpolations outside attributes", () => {
    const source = 'html`<p>Hello ${name}!</p>`;';
    const result = transformPartialInterpolations(source);
    assert.equal(result, source);
  });

  it("does not touch comments inside templates", () => {
    const source = 'html`<div><!-- ${notAnAttr} --><a href="/x">y</a></div>`;';
    const result = transformPartialInterpolations(source);
    assert.equal(result, source);
  });
});

describe("core capability detection and legacy mode", () => {
  it("warns once when legacy mode is active", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      shouldUseLegacyInterpolation("legacy");
      shouldUseLegacyInterpolation("legacy");
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes("deprecated"), warnings[0]);
    } finally {
      console.warn = original;
    }
  });

  it("detects the installed core capability via templateFeatures", () => {
    // The workspace core build exposes templateFeatures.partialAttributeInterpolation.
    assert.equal(coreSupportsPartialInterpolation(), true);
  });

  it("resolves modes: legacy always transforms, off never transforms", () => {
    assert.equal(shouldUseLegacyInterpolation("legacy"), true);
    assert.equal(shouldUseLegacyInterpolation("off"), false);
    // With a capable core the auto mode skips the legacy transform.
    assert.equal(shouldUseLegacyInterpolation("auto"), false);
  });

  it("keeps transformPartialInterpolations exported for direct consumers", () => {
    const source = 'html' + '`<a href="/blog/${slug}">Post</a>`;';
    const result = transformPartialInterpolations(source);
    assert.ok(result.includes('href=${"/blog/" + (slug)}'), result);
  });
});

describe("transformProjectFiles", () => {
  const root = join(process.cwd(), "test/fixtures/transform-tmp");
  const appDir = join(root, "src/app");
  const islandsDir = join(root, "src/islands");
  const outDir = join(root, ".nix-js/transformed");

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeFixture() {
    await mkdir(join(appDir, "blog", "[slug]"), { recursive: true });
    await mkdir(join(appDir, "lib"), { recursive: true });
    await mkdir(islandsDir, { recursive: true });
    await writeFile(
      join(appDir, "blog", "[slug]", "page.ts"),
      [
        'import { html } from "@deijose/nix-js";',
        'import LikeButton from "../../../islands/LikeButton.ts";',
        'import { getPost } from "../../../../lib/posts.ts";',
        "export default function Page() {",
        '  return html`<a href="/blog/${slug}">x</a>`;',
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(join(appDir, "lib", "posts.ts"), 'export const getPost = () => 1;\n');
    await writeFile(join(islandsDir, "LikeButton.ts"), 'export default function LikeButton() { return null; }\n');
  }

  it("mirrors the tree and compensates relative imports", async () => {
    await writeFixture();
    // Explicit legacy mode forces the transform regardless of core support.
    await transformProjectFiles({ root, appDir, islandsDir, outDir, interpolation: "legacy" });

    const transformedPage = await readFile(join(outDir, "app/blog/[slug]/page.ts"), "utf8");
    // Imports within the mirror base keep working unchanged: the page imports
    // the mirrored island at transformed/islands/LikeButton.ts.
    assert.ok(transformedPage.includes('from "../../../islands/LikeButton.ts"'), transformedPage);
    // Imports that cross the mirror base (src) gain one extra "../" so they
    // resolve to the original location outside the mirror tree.
    assert.ok(transformedPage.includes('from "../../../../../lib/posts.ts"'), transformedPage);
    // Attribute interpolation was rewritten.
    assert.ok(transformedPage.includes('href=${"/blog/" + (slug)}'), transformedPage);

    const island = await readFile(join(outDir, "islands/LikeButton.ts"), "utf8");
    assert.ok(island.includes("LikeButton"));
  });

  it("with a capable core (auto) leaves partial interpolations verbatim", async () => {
    await writeFixture();
    await transformProjectFiles({ root, appDir, islandsDir, outDir });

    const transformedPage = await readFile(join(outDir, "app/blog/[slug]/page.ts"), "utf8");
    // The native runtime path is preserved: no rewrite of the partial.
    assert.ok(transformedPage.includes('href="/blog/${slug}"'), transformedPage);
    assert.ok(!transformedPage.includes('href=${"/blog/" + (slug)}'), transformedPage);
  });

  it("off mode never transforms", async () => {
    await writeFixture();
    await transformProjectFiles({ root, appDir, islandsDir, outDir, interpolation: "off" });

    const transformedPage = await readFile(join(outDir, "app/blog/[slug]/page.ts"), "utf8");
    assert.ok(transformedPage.includes('href="/blog/${slug}"'), transformedPage);
  });
});

describe("fail/redirect helpers", () => {
  it("accepts status-first arguments", () => {
    const failure = fail(400, { email: "bad" });
    assert.equal(failure.status, 400);
    assert.deepEqual(failure.data, { email: "bad" });
    assert.equal(isActionFailure(failure), true);

    const redir = redirect(303, "/login");
    assert.equal(redir.status, 303);
    assert.equal(redir.location, "/login");
    assert.equal(isRedirectResponse(redir), true);
  });

  it("accepts data-first arguments", () => {
    const failure = fail({ email: "bad" }, 400);
    assert.equal(failure.status, 400);
    assert.deepEqual(failure.data, { email: "bad" });

    const redir = redirect("/login");
    assert.equal(redir.status, 303);
    assert.equal(redir.location, "/login");
  });

  it("detects failures across bundling boundaries via markers", () => {
    // Simulate a copy of the class from another bundle (no shared identity).
    class ForeignActionFailure {
      __nix_js_action_failure = true;
      constructor(public status: number, public data: unknown) {}
    }
    const value = new ForeignActionFailure(400, "nope");
    assert.equal(isActionFailure(value), true);
  });
});
