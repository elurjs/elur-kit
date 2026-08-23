import { createRequire } from "node:module";
import type { Plugin } from "vite";

/**
 * How the legacy interpolation transform is handled relative to the installed
 * Nix.js core:
 *
 * - `"auto"` (default): the transform is only applied when the installed core
 *   does NOT support partial attribute interpolation natively.
 * - `"legacy"`: always apply the transform (for migrations), with a one-time
 *   deprecation warning.
 * - `"off"`: never apply the transform. With a core that supports partials
 *   this is the recommended production mode.
 */
export type InterpolationMode = "auto" | "legacy" | "off";

const require = createRequire(import.meta.url);

let _warnedLegacy = false;

function warnLegacyOnce(): void {
  if (_warnedLegacy) return;
  _warnedLegacy = true;
  console.warn(
    "[nix-js-kit] The legacy interpolation transform is deprecated. " +
      "Nix.js core now supports partial attribute interpolation natively. " +
      "Remove `interpolation: \"legacy\"` once migration is complete.",
  );
}

/**
 * Detects whether the installed Nix.js core supports partial attribute
 * interpolation natively (via the public `templateFeatures` capability).
 */
export function coreSupportsPartialInterpolation(): boolean {
  try {
    const core = require("@deijose/nix-js") as {
      templateFeatures?: { partialAttributeInterpolation?: boolean };
    };
    return core?.templateFeatures?.partialAttributeInterpolation === true;
  } catch {
    return false;
  }
}

/**
 * Resolves whether the legacy transform should be applied for the given mode.
 */
export function shouldUseLegacyInterpolation(mode: InterpolationMode): boolean {
  if (mode === "off") return false;
  if (mode === "legacy") {
    warnLegacyOnce();
    return true;
  }
  return !coreSupportsPartialInterpolation();
}

/**
 * Transforms Nix.js `html\`\`` templates so that attributes with partial
 * interpolation become a single interpolation expression.
 *
 * Nix.js requires every dynamic attribute to be a single interpolation covering
 * the whole value. This plugin rewrites patterns such as:
 *
 *   html\`<a href="/blog/${slug}">...</a>\`
 *
 * into:
 *
 *   html\`<a href=${"/blog/" + slug}>...</a>\`
 *
 * Only files inside the app and islands directories are processed.
 *
 * @deprecated Nix.js core supports partial attribute interpolation natively.
 *   Keep this transform only for migrations against older cores
 *   (`interpolation: "legacy"`).
 */
export interface InterpolationPluginOptions {
  appDir?: string;
  islandsDir?: string;
}

const HTML_TAG = "html";
const TEMPLATE_START = "`";

/**
 * Scans a `${...}` interpolation starting at `start` (where content[start] is
 * `$` and content[start + 1] is `{`), honoring nested braces, strings and
 * escape sequences. Returns the index just past the closing `}`.
 */
function scanInterpolation(content: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < content.length && depth > 0) {
    const c = content[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < content.length) {
        if (content[i] === "\\") {
          i += 2;
          continue;
        }
        if (content[i] === q) break;
        i++;
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return i;
}

/**
 * Scans a quoted attribute value starting at `start` (where content[start] is
 * the quote character). Handles escapes, `${...}` interpolations with nested
 * braces, and nested quotes. Returns the index just past the closing quote,
 * the raw inner text (escapes preserved as in the source) and whether the
 * value contains at least one interpolation.
 */
function scanQuotedValue(
  content: string,
  start: number,
  quote: string,
): { end: number; inside: string; hasInterp: boolean } {
  let i = start + 1;
  let inside = "";
  let hasInterp = false;
  while (i < content.length) {
    const c = content[i];
    if (c === "\\") {
      inside += c + (content[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === quote) {
      i++;
      break;
    }
    if (c === "$" && content[i + 1] === "{") {
      const end = scanInterpolation(content, i);
      inside += content.slice(i, end);
      i = end;
      hasInterp = true;
      continue;
    }
    inside += c;
    i++;
  }
  return { end: i, inside, hasInterp };
}

/**
 * Converts the inner text of a quoted attribute value (which may contain
 * `${...}` interpolations) into a JS expression. Literal parts are JSON
 * encoded; interpolations keep their raw expression text.
 *
 * Examples:
 *   /blog/${slug}     -> "/blog/" + (slug)
 *   ${slug}           -> (slug)
 *   tag ${cls({a:1})} -> "tag " + (cls({a:1}))
 */
function valueToExpression(value: string): string {
  const parts: string[] = [];
  let i = 0;
  let literal = "";
  const flush = () => {
    if (literal) {
      parts.push(JSON.stringify(unescapeAttributeLiteral(literal)));
      literal = "";
    }
  };

  while (i < value.length) {
    if (value[i] === "\\") {
      literal += value[i] + (value[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (value[i] === "$" && value[i + 1] === "{") {
      flush();
      const end = scanInterpolation(value, i);
      const expr = value.slice(i + 2, end - 1).trim();
      if (expr) parts.push(`(${expr})`);
      i = end;
      continue;
    }
    literal += value[i];
    i++;
  }
  flush();

  if (parts.length === 0) return '""';
  if (parts.length === 1) return parts[0] as string;
  return parts.join(" + ");
}

/**
 * Unescapes escape sequences that appear inside a JS template literal so the
 * JSON.stringify output matches the runtime string value.
 */
function unescapeAttributeLiteral(literal: string): string {
  const escapes: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
  };
  let out = "";
  let i = 0;
  while (i < literal.length) {
    const c = literal[i];
    if (c === "\\" && i + 1 < literal.length) {
      const next = literal[i + 1];
      if (next in escapes) {
        out += escapes[next];
        i += 2;
        continue;
      }
      out += next;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Rewrites quoted attribute values that contain interpolations inside html``
 * templates, leaving everything else untouched.
 */
function transformTemplateContent(content: string): string {
  let out = "";
  let i = 0;
  const n = content.length;

  while (i < n) {
    const lt = content.indexOf("<", i);
    if (lt === -1) {
      out += content.slice(i);
      break;
    }
    out += content.slice(i, lt);
    i = lt;

    // HTML comments: copy verbatim.
    if (content.startsWith("<!--", i)) {
      const end = content.indexOf("-->", i + 4);
      if (end === -1) {
        out += content.slice(i);
        break;
      }
      out += content.slice(i, end + 3);
      i = end + 3;
      continue;
    }

    // Closing tags, doctype, CDATA, processing instructions: copy verbatim.
    if (content[i + 1] === "/" || content[i + 1] === "!" || content[i + 1] === "?") {
      const gt = content.indexOf(">", i + 1);
      if (gt === -1) {
        out += content.slice(i);
        break;
      }
      out += content.slice(i, gt + 1);
      i = gt + 1;
      continue;
    }

    // Opening tag. Copy the tag name, then walk its attributes.
    let j = i + 1;
    while (j < n && /[a-zA-Z0-9-]/.test(content[j])) j++;
    out += content.slice(i, j);
    i = j;

    while (i < n) {
      let ws = "";
      while (i < n && /\s/.test(content[i])) {
        ws += content[i];
        i++;
      }
      if (i >= n) {
        out += ws;
        break;
      }
      if (content[i] === ">") {
        out += ws + ">";
        i++;
        break;
      }
      if (content[i] === "/" && content[i + 1] === ">") {
        out += ws + "/>";
        i += 2;
        break;
      }
      // Interpolation in the tag body (dynamic attrs/spread): copy verbatim.
      if (content[i] === "$" && content[i + 1] === "{") {
        const end = scanInterpolation(content, i);
        out += ws + content.slice(i, end);
        i = end;
        continue;
      }

      // Attribute name.
      let nameStart = i;
      while (i < n && !/[\s=/>"'$]/.test(content[i])) i++;
      const name = content.slice(nameStart, i);
      if (!name) {
        out += ws + content[i];
        i++;
        continue;
      }

      let eqWs = "";
      while (i < n && /\s/.test(content[i])) {
        eqWs += content[i];
        i++;
      }

      if (content[i] !== "=") {
        out += ws + name + eqWs;
        continue;
      }

      i++; // consume "="
      let valWs = "";
      while (i < n && /\s/.test(content[i])) {
        valWs += content[i];
        i++;
      }

      const quote = content[i];
      if (quote === '"' || quote === "'") {
        const { end, inside, hasInterp } = scanQuotedValue(content, i, quote);
        if (hasInterp) {
          // Skip values that are a single full interpolation: Nix.js handles
          // `attr="${expr}"` natively, so only partial interpolations need the
          // rewrite.
          const first = scanInterpolation(inside, 0);
          const fullValue =
            inside.startsWith("${") &&
            first === inside.length &&
            !inside.slice(2, first - 1).includes("${");
          if (!fullValue) {
            // Nix.js needs the interpolation to start right after "=" (no space),
            // so the whitespace before the original value is dropped.
            out += ws + name + eqWs + "=" + "${" + valueToExpression(inside) + "}";
            i = end;
            continue;
          }
          out += ws + name + eqWs + "=" + valWs + content.slice(i, end);
        } else {
          out += ws + name + eqWs + "=" + valWs + content.slice(i, end);
        }
        i = end;
        continue;
      }

      // Unquoted value: copy up to whitespace, ">" or "/>".
      let v = "";
      while (
        i < n &&
        !/\s/.test(content[i]) &&
        content[i] !== ">" &&
        !(content[i] === "/" && content[i + 1] === ">")
      ) {
        v += content[i];
        i++;
      }
      out += ws + name + eqWs + "=" + valWs + v;
    }
  }

  return out;
}

/**
 * @deprecated Use the native partial attribute interpolation of Nix.js core
 *   (core >= 3.3). Kept for legacy migrations and direct consumers.
 */
export function transformPartialInterpolations(source: string): string {
  let result = "";
  let i = 0;
  while (i < source.length) {
    // Find the next html` sequence.
    const htmlIndex = source.indexOf(HTML_TAG, i);
    if (htmlIndex === -1) {
      result += source.slice(i);
      break;
    }
    result += source.slice(i, htmlIndex + HTML_TAG.length);
    i = htmlIndex + HTML_TAG.length;

    // Skip whitespace before the backtick.
    while (i < source.length && /\s/.test(source[i])) {
      result += source[i];
      i++;
    }
    if (i >= source.length || source[i] !== TEMPLATE_START) {
      continue;
    }
    result += source[i];
    i++;

    // Parse the template literal until the matching backtick.
    let depth = 1;
    let templateContent = "";
    while (i < source.length && depth > 0) {
      const char = source[i];
      if (char === "\\") {
        templateContent += char + source[i + 1];
        i += 2;
        continue;
      }
      if (char === TEMPLATE_START) {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      if (char === "$") {
        // Look ahead for ${...}
        if (source[i + 1] === "{") {
          const end = scanInterpolation(source, i);
          templateContent += source.slice(i, end);
          i = end;
          continue;
        }
      }
      templateContent += char;
      i++;
    }

    const transformed = transformTemplateContent(templateContent);
    result += transformed;
    result += TEMPLATE_START;
  }
  return result;
}

export function nixJsInterpolationPlugin(options: InterpolationPluginOptions = {}): Plugin {
  const appDir = options.appDir ?? "src/app";
  const islandsDir = options.islandsDir ?? "src/islands";
  return {
    name: "nix-js-kit-interpolation",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".ts") && !id.endsWith(".js")) return;
      if (!id.includes(appDir) && !id.includes(islandsDir)) return;
      if (!code.includes("html`")) return;
      const transformed = transformPartialInterpolations(code);
      if (transformed === code) return;
      return { code: transformed, map: null };
    },
  };
}
