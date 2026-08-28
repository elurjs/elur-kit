import { html } from "@elurjs/core";

export default function ErrorPage() {
  return html`
    <article class="error-page">
      <h1>500</h1>
      <p>Algo salió mal. Intenta recargar la página.</p>
      <a href="/">Volver al inicio</a>
    </article>
  `;
}
