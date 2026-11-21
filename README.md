# Mi Música — tu música de Google Drive, sin anuncios

PWA (app web instalable) que reproduce los MP3 que guardas en tu Google Drive.
Sigue sonando con la pantalla apagada y muestra controles en la pantalla de bloqueo.

## Paso 1 — Crear el acceso con Google (una sola vez, gratis)

1. Entra a https://console.cloud.google.com e inicia sesión con tu Gmail.
2. Arriba, crea un proyecto nuevo (nombre: "Mi Musica").
3. Menú → **APIs y servicios → Biblioteca** → busca **Google Drive API** → **Habilitar**.
4. Menú → **APIs y servicios → Pantalla de consentimiento de OAuth**:
   - Tipo de usuario: **Externo**. Nombre de la app: "Mi Música". Tu correo en soporte y contacto.
   - En **Usuarios de prueba**, agrega tu mismo Gmail. (Importante: sin esto Google no te deja entrar.)
5. Menú → **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo: **Aplicación web**.
   - En **Orígenes de JavaScript autorizados** pon la dirección donde alojarás la app
     (ver paso 2), por ejemplo `https://tu-usuario.github.io`. Sin barra final y sin ruta.
   - Para probar en tu computador agrega también `http://localhost:8080`.
6. Copia el **ID de cliente** (termina en `.apps.googleusercontent.com`) y pégalo en `config.js`.

## Paso 2 — Publicar la app (gratis, necesita HTTPS)

La opción más fácil es **GitHub Pages**, **Netlify** o **Cloudflare Pages**: subes la carpeta
y te dan una dirección `https://...`. Esa dirección es la que va en el paso 1.5.

Para probar local: `python3 -m http.server 8080` dentro de la carpeta y abre http://localhost:8080

## Paso 3 — Subir tu música a Drive

Crea una carpeta llamada **Mi Música** (o el nombre que pongas en `config.js`) y sube tus MP3.
Mejor si los archivos se llaman `Artista - Título.mp3`; si tienen etiquetas ID3 (portada, título,
artista) la app las lee sola al reproducir.

## Paso 4 — Instalarla en el celular

- **Android (Chrome):** abre la dirección → menú ⋮ → **Instalar aplicación**.
- **iPhone (Safari):** abre la dirección → botón Compartir → **Añadir a pantalla de inicio**.

## Notas

- La sesión de Google dura 1 hora y la app la renueva sola. Si Google pide entrar de nuevo, es normal.
- Con la app en modo "Pruebas" Google puede pedir volver a autorizar cada ~7 días. Es un límite de Google
  para apps sin verificar; para uso personal basta con volver a tocar "Entrar con Google".
- Pantalla apagada: en Android funciona muy bien. En iPhone funciona también, pero iOS es más estricto;
  si algo falla, avísame y lo ajustamos.

## Novedades: sesión y listas en la nube

- **Sesión:** Google solo da permisos de 1 hora. Si vence, la app ya no te saca: sigue abierta
  y muestra un aviso naranja "Renovar sesión". Cualquier toque en la app también la renueva
  cuando le queda poco tiempo.
- **Listas y favoritas en la nube:** se guardan en una carpeta oculta de la app dentro del Drive
  de cada persona (no ocupan espacio visible). Cada persona ve solo las suyas, y no se pierden
  al cambiar de celular o reinstalar.
- **Permiso nuevo:** en Google Cloud → Google Auth Platform → **Acceso a los datos** (Data Access)
  → **Agregar o quitar permisos** → marca `.../auth/drive.appdata` → Guardar.
  Cada persona verá una casilla extra la próxima vez que entre y debe dejarla marcada.
- Para desactivar las listas en la nube: `CLOUD_SYNC: false` en `config.js`.
