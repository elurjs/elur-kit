// --- Frontmatter parser (YAML subset, zero dependencies) ---
//
// Parses the YAML subset that covers ~95% of real-world frontmatter:
//   - scalar key/value pairs (strings, numbers, booleans, null)
//   - dates (ISO 8601)
//   - inline arrays: [a, b, c]
//   - block arrays:
//       tags:
//         - foo
//         - bar
//   - quoted strings (single and double)
//
// This is NOT a full YAML parser. It deliberately rejects nested mappings and
// complex types. If a project needs full YAML, it can install `yaml` as a peer
// dependency and we can add a fallback later.

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Splits a Markdown document into frontmatter and body. Returns the raw
 * frontmatter string (without the `---` fences) and the body.
 */
export function splitFrontmatter(source: string): { raw: string; body: string } {
  if (!source.startsWith("---")) return { raw: "", body: source };

  // Find the closing `---` on its own line.
  const rest = source.slice(3);
  const closeMatch = rest.match(/^.*?\n---[ \t]*\r?\n?/s);
  if (!closeMatch) return { raw: "", body: source };

  const raw = rest.slice(0, closeMatch.index! + closeMatch[0].length - 4).trim();
  const body = rest.slice(closeMatch.index! + closeMatch[0].length);
  return { raw, body };
}

/**
 * Parses a YAML-subset frontmatter string into a JS object.
 */
export function parseFrontmatter(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines and comments.
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const kvMatch = line.match(/^(\S[^:]*):\s*(.*)$/);
    if (!kvMatch) {
      i++;
      continue;
    }

    const key = kvMatch[1].trim();
    const value = kvMatch[2].trim();

    // Block array: value is empty, next lines are indented `- item`.
    if (value === "") {
      // Check if next lines are indented list items.
      const items: unknown[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        if (!nextLine.trim()) {
          j++;
          continue;
        }
        const listItemMatch = nextLine.match(/^\s+-\s+(.*)$/);
        if (listItemMatch) {
          items.push(parseScalar(listItemMatch[1].trim()));
          j++;
          continue;
        }
        // Indented non-list content (nested mapping) — not supported.
        if (/^\s+\S/.test(nextLine) && !listItemMatch) {
          // Could be a nested map; we skip it gracefully.
          j++;
          continue;
        }
        break;
      }
      if (items.length > 0) {
        result[key] = items;
        i = j;
      } else {
        // Empty value (null).
        result[key] = null;
        i++;
      }
      continue;
    }

    result[key] = parseValue(value);
    i++;
  }

  return result;
}

/**
 * Parses a scalar value, handling inline arrays, quoted strings, numbers,
 * booleans, null and ISO dates.
 */
function parseValue(value: string): unknown {
  // Inline array: [a, b, c]
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseScalar(item.trim()));
  }
  return parseScalar(value);
}

function parseScalar(value: string): unknown {
  if (!value) return null;

  // Double-quoted string.
  if (value.startsWith('"') && value.endsWith('"')) {
    return unescapeQuoted(value.slice(1, -1));
  }
  // Single-quoted string.
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }

  // Boolean.
  const lower = value.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "null" || lower === "~") return null;

  // Number (int, float, negative, scientific).
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  if (/^-?\d+(\.\d+)?[eE][-+]?\d+$/.test(value)) return parseFloat(value);

  // ISO date: YYYY-MM-DD or full ISO 8601.
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) {
    const date = new Date(value);
    if (!isNaN(date.getTime())) return date;
  }

  // Plain string.
  return value;
}

function unescapeQuoted(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/**
 * Parses a full Markdown document (frontmatter + body) in one call.
 */
export function parseDocument(source: string): ParsedFrontmatter {
  const { raw, body } = splitFrontmatter(source);
  const data = raw ? parseFrontmatter(raw) : {};
  return { data, body: body.trimStart() };
}
