import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  processImageBatch,
  readManifest,
  writeManifest,
  getManifestEntry,
  buildSrcset,
  buildPictureMarkup,
  validateManifestUrls,
  isSharpAvailable,
  type ImageManifest,
} from "../src/image/service.ts";
import { image, consumeImageRegistry, setImageManifest } from "../src/image/index.ts";
import { renderToString } from "../src/render/render-to-string.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tempRoot = resolve(__dirname, "fixtures/minimal/.tmp-image-service");

describe("image service: manifest read/write", () => {
  const manifestPath = join(tempRoot, "manifest.json");

  before(async () => {
    await mkdir(tempRoot, { recursive: true });
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("writes and reads a manifest", async () => {
    const manifest: ImageManifest = {
      version: 1,
      entries: {
        "/images/hero.jpg": {
          src: "/images/hero.jpg",
          width: 800,
          height: 600,
          hash: "abc12345",
          variants: [
            { url: "/images/hero-400w-abc12345.webp", width: 400, height: 300, format: "webp", size: 1024 },
          ],
        },
      },
    };
    await writeManifest(manifestPath, manifest);
    assert.ok(existsSync(manifestPath));
    const read = await readManifest(manifestPath);
    assert.deepEqual(read.entries["/images/hero.jpg"].variants[0].url, "/images/hero-400w-abc12345.webp");
  });

  it("returns empty manifest when file missing", async () => {
    const read = await readManifest(join(tempRoot, "nonexistent.json"));
    assert.deepEqual(read.entries, {});
  });
});

describe("image service: buildSrcset", () => {
  it("builds srcset from variants of a given format", () => {
    const entry = {
      src: "/hero.jpg",
      width: 800,
      height: 600,
      hash: "abc",
      variants: [
        { url: "/hero-400w-abc.webp", width: 400, height: 300, format: "webp" as const, size: 100 },
        { url: "/hero-800w-abc.webp", width: 800, height: 600, format: "webp" as const, size: 200 },
        { url: "/hero-400w-abc.avif", width: 400, height: 300, format: "avif" as const, size: 80 },
      ],
    };
    const srcset = buildSrcset(entry, "webp");
    assert.equal(srcset, "/hero-400w-abc.webp 400w, /hero-800w-abc.webp 800w");
  });

  it("returns empty string when no variants match the format", () => {
    const entry = {
      src: "/hero.jpg",
      width: 800,
      height: 600,
      hash: "abc",
      variants: [
        { url: "/hero-400w-abc.webp", width: 400, height: 300, format: "webp" as const, size: 100 },
      ],
    };
    assert.equal(buildSrcset(entry, "avif"), "");
  });
});

describe("image service: buildPictureMarkup", () => {
  it("emits <picture> with <source> per format and fallback <img>", () => {
    const entry = {
      src: "/hero.jpg",
      width: 800,
      height: 600,
      hash: "abc",
      variants: [
        { url: "/hero-400w-abc.webp", width: 400, height: 300, format: "webp" as const, size: 100 },
        { url: "/hero-800w-abc.avif", width: 800, height: 600, format: "avif" as const, size: 200 },
      ],
    };
    const html = buildPictureMarkup(entry, { alt: "Hero", sizes: "100vw" });
    assert.ok(html.includes("<picture>"));
    assert.ok(html.includes('type="image/webp"'));
    assert.ok(html.includes('type="image/avif"'));
    assert.ok(html.includes('srcset="/hero-400w-abc.webp 400w"'));
    assert.ok(html.includes('src="/hero.jpg"'));
    assert.ok(html.includes('alt="Hero"'));
    assert.ok(html.includes('width="800"'));
    assert.ok(html.includes('height="600"'));
    assert.ok(html.includes('sizes="100vw"'));
    assert.ok(html.includes("</picture>"));
  });

  it("emits plain <img> when no variants exist", () => {
    const entry = {
      src: "/hero.jpg",
      width: 800,
      height: 600,
      hash: "abc",
      variants: [],
    };
    const html = buildPictureMarkup(entry, { alt: "Hero" });
    assert.ok(!html.includes("<picture>"));
    assert.ok(html.includes("<img"));
    assert.ok(html.includes('src="/hero.jpg"'));
  });

  it("includes priority attributes when priority=true", () => {
    const entry = {
      src: "/hero.jpg",
      width: 800,
      height: 600,
      hash: "abc",
      variants: [
        { url: "/hero-800w-abc.webp", width: 800, height: 600, format: "webp" as const, size: 200 },
      ],
    };
    const html = buildPictureMarkup(entry, { alt: "Hero", priority: true });
    assert.ok(html.includes('fetchpriority="high"'));
    assert.ok(!html.includes('loading="lazy"'));
  });

  it("escapes alt text to prevent XSS", () => {
    const entry = {
      src: "/hero.jpg",
      width: 800,
      height: 600,
      hash: "abc",
      variants: [],
    };
    const html = buildPictureMarkup(entry, { alt: '"><script>alert(1)</script>' });
    assert.ok(html.includes("&quot;"));
    assert.equal((html.match(/<img/g) || []).length, 1);
  });
});

describe("image service: getManifestEntry", () => {
  it("looks up entry by src", () => {
    const manifest: ImageManifest = {
      version: 1,
      entries: {
        "/a.jpg": { src: "/a.jpg", width: 100, height: 100, hash: "a", variants: [] },
      },
    };
    assert.ok(getManifestEntry(manifest, "/a.jpg"));
    assert.equal(getManifestEntry(manifest, "/b.jpg"), undefined);
  });
});

describe("image service: validateManifestUrls", () => {
  const outDir = join(tempRoot, "validate");

  before(async () => {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "exists.webp"), "fake", "utf8");
  });

  it("reports missing variant files", async () => {
    const manifest: ImageManifest = {
      version: 1,
      entries: {
        "/hero.jpg": {
          src: "/hero.jpg",
          width: 800,
          height: 600,
          hash: "abc",
          variants: [
            { url: "/exists.webp", width: 800, height: 600, format: "webp", size: 100 },
            { url: "/missing.webp", width: 400, height: 300, format: "webp", size: 50 },
          ],
        },
      },
    };
    const missing = await validateManifestUrls(manifest, outDir);
    assert.deepEqual(missing, ["/missing.webp"]);
  });
});

describe("image service: processImageBatch without sharp", () => {
  const publicDir = join(tempRoot, "public");
  const outDir = join(tempRoot, "out");
  const manifestPath = join(outDir, ".elur", "image-manifest.json");

  before(async () => {
    await mkdir(publicDir, { recursive: true });
    await mkdir(join(publicDir, "images"), { recursive: true });
    // Write a minimal JPEG (not a real image, just data for hashing).
    await writeFile(join(publicDir, "images", "hero.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("produces a manifest even without sharp (entries without variants)", async () => {
    const result = await processImageBatch(
      [{ src: "/images/hero.jpg", widths: [400, 800] }],
      { publicDir, outDir, manifestPath },
    );
    assert.equal(result.optimized, isSharpAvailableSync());
    assert.ok(result.manifest.entries["/images/hero.jpg"]);
    assert.equal(result.manifest.entries["/images/hero.jpg"].src, "/images/hero.jpg");
  });
});

describe("image(): manifest-driven <picture> markup", () => {
  it("emits <picture> when manifest has variants", async () => {
    const manifest: ImageManifest = {
      version: 1,
      entries: {
        "/images/hero.jpg": {
          src: "/images/hero.jpg",
          width: 800,
          height: 600,
          hash: "abc12345",
          variants: [
            { url: "/images/hero-400w-abc12345.webp", width: 400, height: 300, format: "webp", size: 1024 },
            { url: "/images/hero-800w-abc12345.avif", width: 800, height: 600, format: "avif", size: 2048 },
          ],
        },
      },
    };
    setImageManifest(manifest);
    try {
      const html = await renderToString(() => image({
        src: "/images/hero.jpg",
        alt: "Hero",
        width: 800,
        height: 600,
        widths: [400, 800],
        sizes: "100vw",
      }));
      assert.ok(html.includes("<picture>"));
      assert.ok(html.includes('type="image/webp"'));
      assert.ok(html.includes('type="image/avif"'));
      assert.ok(html.includes('srcset="/images/hero-400w-abc12345.webp 400w"'));
      assert.ok(html.includes('src="/images/hero.jpg"'));
    } finally {
      setImageManifest(null);
    }
  });

  it("emits plain <img> when manifest has no entry", async () => {
    setImageManifest({ version: 1, entries: {} });
    try {
      const html = await renderToString(() => image({
        src: "/images/unknown.jpg",
        alt: "Unknown",
        width: 800,
        height: 600,
      }));
      assert.ok(!html.includes("<picture>"));
      assert.ok(html.includes('src="/images/unknown.jpg"'));
    } finally {
      setImageManifest(null);
    }
  });

  it("emits plain <img> when manifest is null", async () => {
    setImageManifest(null);
    const html = await renderToString(() => image({
      src: "/images/plain.jpg",
      alt: "Plain",
      width: 800,
      height: 600,
    }));
    assert.ok(!html.includes("<picture>"));
    assert.ok(html.includes('src="/images/plain.jpg"'));
  });

  it("still registers images for processing when manifest is null", async () => {
    consumeImageRegistry();
    setImageManifest(null);
    await renderToString(() => image({
      src: "/images/reg.jpg",
      alt: "Reg",
      width: 800,
      height: 600,
      widths: [400, 800],
    }));
    const reg = consumeImageRegistry();
    assert.equal(reg.length, 1);
    assert.equal(reg[0].src, "/images/reg.jpg");
  });
});

function isSharpAvailableSync(): boolean {
  // isSharpAvailable is async; for the test assertion we just check if the
  // processImageBatch result says optimized.
  return false;
}
