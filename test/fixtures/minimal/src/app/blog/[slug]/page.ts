import { html } from "@elurjs/core";
import type { PageProps } from "../../../../../../src/index.ts";
import { load } from "./page.data.ts";

export default function BlogPostPage({ data, params }: PageProps<typeof load>) {
  return html`<article><h1>${data.title}</h1><p>${params.slug}</p></article>`;
}
