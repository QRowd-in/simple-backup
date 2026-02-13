# simple-backup

A lightweight PostgreSQL backup utility that dumps a database, compresses it with gzip, and uploads to S3-compatible storage (including Cloudflare R2). It also manages backup retention by automatically cleaning up old backups.

## Features

- **PostgreSQL backup** using `pg_dump`
- **Automatic compression** with gzip
- **S3-compatible storage** - works with AWS S3, Cloudflare R2, and other S3-compatible providers
- **Serverless Postgres support** - waits for database to be reachable (handles sleeping serverless databases)
- **Backup retention** - automatically deletes old backups beyond a configurable limit

## Requirements

- Bun runtime
- `pg_dump` command-line tool (must be installed on the system)
- S3-compatible storage (AWS S3, Cloudflare R2, MinIO, etc.)

## Installation

```bash
bun install
```

## Configuration

Configure via environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (e.g., `postgres://user:pass@host:5432/db`) |
| `S3_BUCKET` | Yes | S3 bucket name |
| `S3_ENDPOINT` | Yes | S3 endpoint URL (e.g., `https://<account-id>.r2.cloudflarestorage.com` for R2) |
| `S3_ACCESS_KEY_ID` | Yes | S3 access key ID |
| `S3_SECRET_ACCESS_KEY` | Yes | S3 secret access key |
| `S3_REGION` | No | S3 region (default: `auto`) |
| `BACKUP_PREFIX` | No | S3 key prefix for backups (default: `backups/<dbname>`) |
| `BACKUP_MAX_COUNT` | No | Maximum backups to retain (default: `30`) |
| `PG_CONNECT_TIMEOUT` | No | Timeout for waiting for Postgres in seconds (default: `120`) |

## Usage

```bash
bun run index.ts
```

## Docker

Build and run with Docker:

```bash
docker build -t simple-backup .
docker run --rm \
  -e DATABASE_URL="postgres://user:pass@host:5432/db" \
  -e S3_BUCKET="my-backups" \
  -e S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  -e S3_ACCESS_KEY_ID="..." \
  -e S3_SECRET_ACCESS_KEY="..." \
  simple-backup
```

## Example .env file

```bash
DATABASE_URL=postgres://user:password@localhost:5432/mydb
S3_BUCKET=backups
S3_ENDPOINT=https://your-account.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=your_access_key
S3_SECRET_ACCESS_KEY=your_secret_key
S3_REGION=auto
BACKUP_PREFIX=backups/mydb/
BACKUP_MAX_COUNT=30
```

## How it works

1. **Connect** - Validates configuration and waits for Postgres to be reachable
2. **Dump** - Runs `pg_dump` to create a SQL dump of the database
3. **Compress** - Compresses the dump with gzip
4. **Upload** - Uploads the compressed backup to S3 with timestamp in filename
5. **Cleanup** - Deletes old backups exceeding the retention limit

## License

MIT
