[English](README.md) | **Español**

# Scripts de configuración del workshop

Automatiza la creación de repositorios personalizados del workshop de GitHub Copilot para cada asistente en una organización de GitHub.

## Requisitos previos

- Node.js 18+
- Personal Access Token de GitHub con los scopes: `repo`, `admin:org`, `workflow`, `delete_repo`
- Acceso de administrador a una organización de GitHub para los repositorios del workshop

## Configuración inicial

1. Clona este repositorio e instala las dependencias:

   ```bash
   git clone <this-repo-url> && cd demo-setup-scripts
   npm install
   ```

2. Configura las variables de entorno:

   ```bash
   cp .env.example .env
   ```

   Edita `.env` con tu token, tu organización y los ajustes del workshop. Consulta [Configuración](#configuración) más abajo.

3. Agrega los asistentes:

   ```bash
   cp attendees.csv.example attendees.csv
   ```

   Edita `attendees.csv` con los nombres de usuario de GitHub de los participantes. Consulta [Formato del CSV de asistentes](#formato-del-csv-de-asistentes) más abajo.

## Uso

### Crear los repositorios del workshop

```bash
npm start
```

El tarball de la release se descarga automáticamente desde GitHub releases en la primera ejecución. Si ya existe localmente, se omite la descarga.

### Validar la configuración

```bash
npm run validate
```

### Limpiar los repositorios después del workshop

Previsualiza lo que se eliminará (recomendado primero):

```bash
npm run cleanup:dry-run
```

Elimina todos los repositorios del workshop (requiere escribir "DELETE" para confirmar):

```bash
npm run cleanup
```

## Configuración

Define estos valores en tu archivo `.env`:

| Variable | Obligatoria | Valor por defecto | Descripción |
|----------|-------------|-------------------|-------------|
| `GITHUB_TOKEN` | Sí | -- | Personal access token |
| `TARGET_ORG` | Sí | -- | Organización de GitHub para los repositorios del workshop |
| `CSV_FILE` | No | `attendees.csv` | Ruta al CSV de asistentes |
| `RELEASE_TARBALL` | No | `./release.tar.gz` | Ruta al tarball de la release preparada (se descarga automáticamente si falta) |
| `RELEASE_ASSET_NAME` | No | Nombre base de `RELEASE_TARBALL` | Nombre del asset de la release de GitHub, si difiere del nombre de archivo local |
| `RELEASE_OWNER` | No | -- | Propietario de GitHub para el origen de la descarga automática |
| `RELEASE_REPO` | No | -- | Repositorio de GitHub para el origen de la descarga automática |
| `RELEASE_TAG` | No | -- | Etiqueta de la release para el origen de la descarga automática |
| `CUSTOMER_NAME` | No | `Copilot` | Nombre del cliente insertado en el contenido del workshop |
| `WORKSHOP_DURATION` | No | `Full Day (8 hours)` | Duración insertada en el contenido del workshop |
| `BACKEND` | No | `nodejs` | Lenguaje de backend para el contenido del workshop |
| `ENABLE_CODESPACES_PREBUILDS` | No | `true` | Habilita las prebuilds de Codespaces |
| `CONCURRENT_ATTENDEES` | No | `5` | Asistentes procesados en paralelo |
| `CONCURRENT_REPOS` | No | `3` | Repositorios por asistente procesados en paralelo |

## Formato del CSV de asistentes

```csv
github_username,email
octocat,octocat@github.com
```

`github_username` es obligatorio. `email` es opcional y solo para tus registros.

## Mantenedores: preparar una release

1. Coloca el archivo comprimido de origen de Octodemo en `source-release.tar.gz`, en la raíz del repositorio.
2. Ejecuta el script de preparación:

   ```bash
   npm run prepare-release
   ```

   El comando valida la estructura del archivo comprimido, elimina los archivos
   sensibles y no deseados, aplica los reemplazos del workshop y genera:

   - `release.tar.gz`
   - `release.tar.gz.sha256`

   Sobrescribe las rutas con `INPUT_RELEASE_TARBALL` y
   `OUTPUT_RELEASE_TARBALL` cuando sea necesario. Define `SOURCE_DATE_EPOCH` para conservar
   una marca de tiempo de release concreta; de lo contrario, las marcas de tiempo se normalizan
   para obtener una salida reproducible. Para un paquete de origen con otra estructura, define
   `RELEASE_SOURCE_REPO` (valor por defecto: `octocatSupply`) y la lista separada por comas
   `RELEASE_BRANCHES`.

3. Crea una release en GitHub y sube ambos archivos generados. El asset del tarball
   debe llamarse `release.tar.gz`.
