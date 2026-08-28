import { describe, it } from "node:test";
import assert from "node:assert";
import { transformPartialInterpolations } from "../src/vite/interpolation-plugin";

describe("elurJsInterpolationPlugin transform", () => {
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
});
