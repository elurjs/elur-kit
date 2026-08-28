import { html } from "@elurjs/core";
import type { LayoutProps } from "../../../../../src/index.ts";

export default function RootLayout({ children }: LayoutProps) {
  return html`<div class="layout">${children}</div>`;
}
