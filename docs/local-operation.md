# Local operation

## Requirements

- Node.js `>= 22.13.0`
- A root `.env` copied from `.env.example`
- Provider credentials only when operating collection workflows

```bash
cp .env.example .env
# Set required local credentials in .env; never commit this file.
cd apps/web-dashboard
npm ci
```

## Dashboard and collector

For development:

```bash
cd apps/web-dashboard
npm run dev
```

The repository also includes macOS `.command` launchers for the local workflow. They locate the repository relative to themselves and create ignored subdirectory `.env` symlinks when necessary. They are convenience tools, not required for CI.

## Validation

```bash
cd apps/web-dashboard
npm test
npm run build
```

Tests use mocks and synthetic databases where appropriate. They should not require real API calls or a live WebSocket.

## Local database operations

The project targets local Miniflare D1 only. Review [local D1 schema operations](local-d1-migrations.md) before any schema adoption command. Keep a backup before an intentional local schema operation; do not point these commands at a remote database.

## Data handling

Local `data/`, `.wrangler/`, logs, JSONL, SQLite files, and `.env` are ignored by Git. They may contain provider responses or machine-specific state and should not be added to a public repository.
