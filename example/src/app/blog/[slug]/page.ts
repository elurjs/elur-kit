import { html } from "@elurjs/core";
import type { PageProps, GenerateStaticParams } from "@elurjs/kit";
import type { PostData } from "./page.data.ts";

export const generateStaticParams: GenerateStaticParams = async () => {
  return [
    { slug: "hello-world" },
    { slug: "elur-kit" },
  ];
};

export default function BlogPostPage({ data, params }: PageProps<PostData>) {
  return html`
    <article class="blog-post">
      <h1>${data.title}</h1>
      <p>Slug: ${params.slug}</p>
      <p>${data.body}</p>
      <a href="/">← Back home</a>
    </article>
  `;
}
