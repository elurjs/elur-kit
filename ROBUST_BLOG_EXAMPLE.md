# Resumen: ejemplo robusto de Elur Kit

Este documento describe los ajustes realizados para convertir el blog de ejemplo en una aplicación full-stack real con SQLite, autenticación, middleware, validación y server/client actions.

## 1. Cambios en `elur-kit` (framework)

### Nuevas capacidades

- **Soporte para `layout.data.ts`**: `renderPage` ahora detecta un loader `layout.data.ts` junto a cada `layout.ts`, carga sus datos y se los pasa al componente de layout vía `LayoutProps.data`.
- **Request en loaders**: `PageDataLoad` recibe `request?: Request` en su contexto. Esto permite que los data loaders accedan a cookies, headers y sesión durante SSR.
- **Request en servidor SSR**: `createSsrServer` y `renderPageBody` construyen un objeto `Request` a partir de `IncomingMessage` y lo propagan a `renderPage` / `renderStreamingPage`.
- **Tipos actualizados**: `LayoutProps` ya exponía `data` y `PageProps` ya exponía `layoutData`; ahora el runtime los implementa.

### Archivos modificados en el framework

- `src/ssr/render.ts`
- `src/ssr/server.ts`
- `src/ssr/stream.ts`
- `src/types.ts` (ya tenía los tipos, se usan ahora)
- `package.json` (versión `1.2.5`)
- `CHANGELOG.md`

## 2. Cambios en `blog-example`

### Backend SQLite

- `src/app/lib/db.ts`: esquema, seed, WAL y funciones CRUD para usuarios, sesiones, posts, comentarios, likes y suscriptores.
- `src/app/lib/hash.ts`: hash y verificación de contraseñas con PBKDF2 SHA-256.
- `src/app/lib/auth.ts`: login, registro, logout, sesiones por cookie y contexto de auth.
- `src/app/lib/middleware.ts`: `logger`, `cors`, `rateLimit`, `requireAuth`, `requireAdmin` y `withMiddleware`.
- `src/app/lib/validation.ts`: esquemas Zod para login, registro, contacto, newsletter, posts y comentarios.

### API routes

- `src/app/api/auth/*`: registro, login, logout y `/me`.
- `src/app/api/posts/[slug]/*`: detalle y like (con autenticación).
- `src/app/api/comments/[slug]/route.ts`: GET/POST de comentarios con validación.
- `src/app/api/newsletter/route.ts`: suscripción con validación.
- `src/app/api/admin/*`: stats y creación de posts (solo admin).

### Data loaders / SSR

- `src/app/layout.data.ts`: carga el contexto de auth para mostrar login/register o perfil/logout en el header.
- `src/app/page.data.ts`: posts destacados y estadísticas; refresca cache de posts.
- `src/app/blog/page.data.ts`: lista de posts y tags; refresca cache de posts.
- `src/app/blog/[slug]/page.data.ts`: detalle de post, comentarios y likes.
- `src/app/profile/page.data.ts`: página privada que requiere auth.
- `src/app/admin/page.data.ts`: estadísticas admin; solo si el usuario es admin.
- `src/app/admin/posts/page.data.ts`: contexto de auth para crear posts.

### Islands y actions

- `src/islands/AuthForm.ts`: login/register con fetch a la API.
- `src/islands/LogoutButton.ts`: logout vía API.
- `src/islands/CreatePostForm.ts`: formulario admin para crear posts.
- `src/islands/CommentForm.ts`: envía comentarios a la API.
- `src/islands/LikeButton.ts`: like por API sin actions.
- `src/islands/ClientSearch.ts`: búsqueda client-side con `elur-query` y `/api/posts`.
- `src/islands/ContactForm.ts` / `NewsletterForm.ts`: usan server actions con Zod.
- `src/app/contact/page.action.ts`: valida con Zod y guarda en DB.

### Datos de prueba

| Cuenta         | Correo                | Contraseña | Rol   |
| -------------- | --------------------- | ---------- | ----- |
| admin          | admin@example.com     | `admin123` | admin |
| usuario demo   | user@example.com      | `user123`  | user  |

## 3. Cómo ejecutar

Desde `blog-example`:

```bash
rm -rf data .elur
bun /ruta/a/elur-kit/bin/elur-kit.js dev --port 3000 --host 127.0.0.1
```

La app requiere **Bun** porque usa `bun:sqlite`. No funciona con Node.js puro.

## 4. Pendientes / notas

- Durante el build estático (`elur-kit build`) los loaders reciben `request` como `undefined`; `getAuthContext` ahora maneja ese caso devolviendo un usuario no autenticado.
- `blog-example` no está bajo control de versiones en este workspace; solo se subió a GitHub el framework `elur-kit`.
- El servidor dev quedó validando la integración de layout data + auth; se recomienda revisar con las credenciales de prueba.
