import { html } from "@elurjs/core";

export default function NotFoundPage() {
  return html`
    <article class="error-page">
      <h1>404</h1>
      <p>Página no encontrada.</p>
      <a href="/">Volver al inicio</a>
    </article>
  `;
}
