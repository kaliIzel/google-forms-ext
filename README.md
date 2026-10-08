# Google Forms Extractor & Document Generator

Extensión de Chrome (Manifest V3) que convierte un formulario de Google Forms en **Markdown**, **JSON** o **PDF** sin perder instrucciones, listas ni imágenes. Funciona 100 % en local: no usa IA, no hace peticiones a servicios externos y no envía datos a ningún servidor.

## Características

- **Extracción fiel del texto**: recorre el bloque completo de cada tarjeta (instrucciones largas, listas numeradas, viñetas, negritas y saltos de línea), no solo el título.
- **Enlaces limpios**: desenvuelve los redirectores `google.com/url?q=...` y los conserva como enlaces Markdown.
- **Imágenes en Base64**: las imágenes protegidas por la sesión de Google se convierten a `data:image/...;base64` dentro de la propia pestaña (canvas oculto, `fetch` con credenciales o CORS anónimo), de modo que se ven en la vista previa y en el PDF.
- **Tipos de pregunta**: opción múltiple, casillas, texto corto y largo, desplegable, escala, carga de archivo, secciones y bloques informativos (texto, imagen, video).
- **Dos formas de usarla**:
  - *Popup* de la extensión, con estadísticas, vista previa, pestañas Markdown/JSON y botones de exportación.
  - *Barra flotante* anclable dentro de la página: se arrastra con el dedo o el ratón, recuerda su posición y tiene los botones Extraer, Copiar Markdown, Descargar JSON, Exportar PDF y Ocultar.
- **Exportación a PDF** mediante la impresión del navegador ("Guardar como PDF"), con tarjetas que no se cortan entre páginas y espera a que carguen todas las imágenes.
- **Pensada también para móvil** (Lemur Browser en Android): controles táctiles de 44 px o más, popup adaptable y barra que se mantiene dentro de la pantalla al rotar.

## Instalación

### Chrome / Edge / Brave (escritorio)

1. Clona o descarga este repositorio:
   ```bash
   git clone git@github.com:kaliIzel/google-forms-ext.git
   ```
2. Abre `chrome://extensions` y activa el **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige la carpeta del proyecto (la que contiene `manifest.json`).
4. Abre un formulario de Google Forms. Si ya estaba abierto, recarga la pestaña.

### Lemur Browser (Android)

Lemur está basado en Chromium e importa extensiones locales en `.crx`. Empaqueta la carpeta desde `chrome://extensions` con **Empaquetar extensión** en el escritorio, pasa el `.crx` al teléfono e impórtalo desde la sección de extensiones de Lemur. El soporte de Manifest V3 depende de la versión de Chromium de Lemur: si la extensión no carga, revisa los errores en su página de extensiones.

## Uso

1. Abre un formulario (`https://docs.google.com/forms/.../viewform`).
2. Usa cualquiera de las dos interfaces:
   - **Barra flotante**: aparece sola en la vista de respuesta. Arrastra el asa `⋮⋮` para moverla; `✕` la oculta y se vuelve a mostrar desde el popup con *Mostrar / ocultar barra flotante*.
   - **Popup**: pulsa el icono de la extensión y luego *Extraer formulario*.
3. Elige la salida:

   | Botón | Resultado |
   | --- | --- |
   | Copiar Markdown | Copia el formulario completo al portapapeles |
   | Descargar JSON | Archivo `google-form-AAAA-MM-DD.json` con los datos y las imágenes en Base64 |
   | Exportar PDF | Abre `print.html`; en el diálogo de impresión elige *Guardar como PDF* |

## Estructura del proyecto

```
google-forms-ext/
├── manifest.json     Configuración MV3, permisos y content scripts
├── background.js     Service worker mínimo: insignia del icono y apertura de print.html
├── content.js        Extracción del DOM de Google Forms, Markdown e imágenes en Base64
├── bar.js            Barra flotante arrastrable (Shadow DOM)
├── render.js         Generador de HTML compartido (vista previa y PDF)
├── popup.html        Interfaz del popup
├── popup.js          Lógica del popup
├── print.html        Página de impresión (PDF)
├── print.js          Carga el documento, espera las imágenes e invoca la impresión
└── README.md
```

`render.js`, `content.js` y `bar.js` se cargan juntos, en ese orden, como content scripts.

## Formato del JSON

```jsonc
{
  "url": "https://docs.google.com/forms/...",
  "extractedAt": "2026-10-07T12:00:00.000Z",
  "title": "Título del formulario",
  "description": "Texto de cabecera en Markdown",
  "images": [],
  "questionCount": 12,
  "sectionCount": 3,
  "infoCount": 2,
  "imageCount": 5,
  "imagesEmbedded": 5,
  "items": [
    { "kind": "section", "index": 0, "title": "...", "description": "...", "images": [], "videos": [] },
    { "kind": "info", "title": "Contexto", "description": "1. ...\n2. ...", "images": [], "videos": [] },
    {
      "kind": "question",
      "number": 1,
      "questionText": "...",
      "helpText": "...",
      "isRequired": true,
      "type": "MULTIPLE_CHOICE",
      "options": [{ "text": "...", "images": [] }],
      "images": [],
      "videos": []
    }
  ]
}
```

Cada imagen incluye `src` (URL original), `dataUrl` (Base64, o `null` si no se pudo convertir), `alt`, `width` y `height`.

## Permisos

| Permiso | Para qué se usa |
| --- | --- |
| `activeTab`, `scripting` | Inyectar los scripts desde el popup si la página se abrió antes de instalar la extensión |
| `storage`, `unlimitedStorage` | Guardar la posición de la barra y pasar el documento de impresión (puede incluir imágenes) |
| `https://docs.google.com/forms/*` | Leer el formulario y mostrar la barra solo en Google Forms |

## Limitaciones conocidas

- Las preguntas de **cuadrícula** (filas × columnas) se tratan como opción múltiple y las etiquetas de fila no se extraen todavía.
- Si una imagen no admite CORS ni `fetch` con credenciales, queda con su URL original; el popup lo avisa.
- Google Forms cambia su HTML con frecuencia. El extractor se apoya en roles ARIA (`heading`, `listitem`, `radio`, ...) y no en clases CSS para resistir esos cambios, pero conviene probarlo tras cada actualización importante.

## Desarrollo

No hay paso de compilación. Edita los archivos, recarga la extensión en `chrome://extensions` y recarga la pestaña del formulario. Para revisar la sintaxis:

```bash
for f in *.js; do node --check "$f"; done
```

## Licencia

Por definir. Si quieres una licencia permisiva, MIT es una opción habitual (añade un archivo `LICENSE`).
