import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToString, documentShell } from "../src/index.ts";
import HomePage from "./src/app/page.ts";
import { load } from "./src/app/page.data.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const searchParams = new URLSearchParams();
  const params = {};

  // 1. Run the loader (server/build-time).
  const data = await load({ params, searchParams });

  // 2. Render the page component to an HTML string.
  const body = await renderToString(() =>
    HomePage({ data, params, searchParams }),
  );

  // 3. Wrap in the document shell + serialize loader data.
  const htmlOut = documentShell({
    title: data.title,
    body,
    data,
    clientEntry: "/_elur/entry-client.js",
  });

  // 4. Write the static file.
  const outDir = join(here, "dist");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "index.html"), htmlOut, "utf8");

  console.log("✓ example/dist/index.html generado\n");
  console.log("--- rendered body ---");
  console.log(body.trim());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
