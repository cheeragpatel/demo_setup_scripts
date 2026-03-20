# Workshop Setup Scripts

Automates creation of personalized GitHub Copilot workshop repositories for each attendee in a GitHub organization.

## Prerequisites

- Node.js 16+
- GitHub Personal Access Token with scopes: `repo`, `admin:org`, `workflow`, `delete_repo`
- Admin access to a GitHub organization for workshop repos

## Setup

1. Clone this repo and install dependencies:

   ```bash
   git clone <this-repo-url> && cd demo-setup-scripts
   npm install
   ```

2. Configure environment variables:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your token, org, and workshop settings. See [Configuration](#configuration) below.

3. Add attendees:

   ```bash
   cp attendees.csv.example attendees.csv
   ```

   Edit `attendees.csv` with participant GitHub usernames. See [Attendee CSV Format](#attendee-csv-format) below.

## Usage

### Create workshop repos

```bash
npm start
```

The release tarball is downloaded automatically from GitHub releases on first run. If it already exists locally, the download is skipped.

### Validate configuration

```bash
npm run validate
```

### Clean up repos after workshop

Preview what will be deleted (recommended first):

```bash
npm run cleanup:dry-run
```

Delete all workshop repos (requires typing "DELETE" to confirm):

```bash
npm run cleanup
```

## Configuration

Set these in your `.env` file:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | -- | Personal access token |
| `TARGET_ORG` | Yes | -- | GitHub org for workshop repos |
| `CSV_FILE` | No | `attendees.csv` | Path to attendee CSV |
| `RELEASE_TARBALL` | No | `./release.tar.gz` | Path to release tarball (auto-downloaded if missing) |
| `RELEASE_OWNER` | No | -- | GitHub owner for auto-download source |
| `RELEASE_REPO` | No | -- | GitHub repo for auto-download source |
| `RELEASE_TAG` | No | -- | Release tag for auto-download source |
| `CUSTOMER_NAME` | No | `Copilot` | Customer name rendered into workshop content |
| `WORKSHOP_DURATION` | No | `Full Day (8 hours)` | Duration rendered into workshop content |
| `BACKEND` | No | `nodejs` | Backend language for workshop content |
| `ENABLE_CODESPACES_PREBUILDS` | No | `true` | Enable Codespaces prebuilds |
| `CONCURRENT_ATTENDEES` | No | `5` | Attendees processed in parallel |
| `CONCURRENT_REPOS` | No | `3` | Repos per attendee processed in parallel |

## Attendee CSV Format

```csv
github_username,email
octocat,octocat@github.com
```

`github_username` is required. `email` is optional and for your records only.

## Maintainer: Preparing a Release

1. Place the source `release.tar.gz` in the repo root.
2. Run the preparation script:

   ```bash
   npm run prepare-release
   ```

3. Upload the generated `workshop-release.tar.gz` to this repository's GitHub releases.