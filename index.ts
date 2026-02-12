import { S3Client, $ } from "bun";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  databaseUrl: string;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string | undefined;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  backupPrefix: string;
  backupMaxCount: number;
  pgConnectTimeout: number;
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith("/") ? s : `${s}/`;
}

function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const s3Bucket = process.env.S3_BUCKET;
  if (!s3Bucket) {
    throw new Error("S3_BUCKET is required");
  }

  const s3AccessKeyId =
    process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID;
  if (!s3AccessKeyId) {
    throw new Error("S3_ACCESS_KEY_ID (or AWS_ACCESS_KEY_ID) is required");
  }

  const s3SecretAccessKey =
    process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY;
  if (!s3SecretAccessKey) {
    throw new Error(
      "S3_SECRET_ACCESS_KEY (or AWS_SECRET_ACCESS_KEY) is required",
    );
  }

  // Extract database name from the connection URL for the default prefix
  let dbName = "db";
  try {
    const url = new URL(databaseUrl);
    dbName = url.pathname.replace(/^\//, "") || "db";
  } catch {
    // If URL parsing fails, fall back to "db"
  }

  return {
    databaseUrl,
    s3Bucket,
    s3Region: process.env.S3_REGION ?? process.env.AWS_REGION ?? "auto",
    s3Endpoint: process.env.S3_ENDPOINT ?? process.env.AWS_ENDPOINT,
    s3AccessKeyId,
    s3SecretAccessKey,
    backupPrefix: ensureTrailingSlash(
      process.env.BACKUP_PREFIX ?? `backups/${dbName}`,
    ),
    backupMaxCount: parseInt(process.env.BACKUP_MAX_COUNT ?? "30", 10),
    pgConnectTimeout: parseInt(process.env.PG_CONNECT_TIMEOUT ?? "120", 10),
  };
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[backup] ${new Date().toISOString()} ${message}`);
}

function logError(message: string): void {
  console.error(`[backup] ${new Date().toISOString()} ERROR: ${message}`);
}

// ---------------------------------------------------------------------------
// Connection wait – handles serverless Postgres that may be sleeping
// ---------------------------------------------------------------------------

async function waitForPostgres(
  databaseUrl: string,
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let delay = 1000; // start at 1s, exponential backoff
  const maxDelay = 30_000; // cap at 30s between retries
  let attempt = 0;

  log(`Waiting for Postgres to be reachable (timeout: ${timeoutSeconds}s)...`);

  while (Date.now() < deadline) {
    attempt++;
    let sql: InstanceType<typeof Bun.SQL> | undefined;
    try {
      // Use Bun's built-in Postgres client for the probe
      sql = new Bun.SQL(databaseUrl);
      await sql`SELECT 1`;
      log(`Postgres is reachable (attempt ${attempt})`);
      return;
    } catch (err) {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      log(
        `Connection attempt ${attempt} failed (${remaining}s remaining): ${(err as Error).message}`,
      );

      if (Date.now() >= deadline) break;

      // Sleep with exponential backoff
      const sleepMs = Math.min(delay, deadline - Date.now(), maxDelay);
      await Bun.sleep(sleepMs);
      delay = Math.min(delay * 2, maxDelay);
    } finally {
      try {
        await sql?.close({ timeout: 1 });
      } catch {
        // Ignore close errors during probe
      }
    }
  }

  throw new Error(
    `Postgres not reachable after ${timeoutSeconds}s (${attempt} attempts)`,
  );
}

// ---------------------------------------------------------------------------
// pg_dump execution
// ---------------------------------------------------------------------------

async function runPgDump(databaseUrl: string): Promise<Uint8Array> {
  log("Running pg_dump...");
  const startTime = Date.now();

  // Use { raw: ... } so the URL is not shell-escaped (it contains @, :, etc.)
  const result = await $`pg_dump ${{ raw: databaseUrl }} | gzip`
    .quiet()
    .arrayBuffer();

  const bytes = new Uint8Array(result);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const sizeMb = (bytes.byteLength / 1024 / 1024).toFixed(2);
  log(`pg_dump completed in ${elapsed}s (${sizeMb} MB compressed)`);

  return bytes;
}

// ---------------------------------------------------------------------------
// S3 upload
// ---------------------------------------------------------------------------

function createS3Client(config: Config): S3Client {
  return new S3Client({
    bucket: config.s3Bucket,
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
  });
}

function generateS3Key(prefix: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}${timestamp}.sql.gz`;
}

async function uploadToS3(
  bucket: S3Client,
  key: string,
  data: Uint8Array,
): Promise<void> {
  log(`Uploading to s3://${key} (${(data.byteLength / 1024 / 1024).toFixed(2)} MB)...`);
  const startTime = Date.now();

  try {
    await bucket.write(key, data, {
      type: "application/gzip",
    });
  } catch (err) {
    // Log full error details for debugging S3 issues
    const error = err as Error;
    logError(`S3 upload failed for key "${key}"`);
    logError(`  Message: ${error.message}`);
    if (error.cause) logError(`  Cause: ${JSON.stringify(error.cause)}`);
    if (error.stack) logError(`  Stack: ${error.stack}`);
    throw err;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Upload completed in ${elapsed}s`);
}

// ---------------------------------------------------------------------------
// Cleanup old backups
// ---------------------------------------------------------------------------

async function cleanupOldBackups(
  bucket: S3Client,
  prefix: string,
  maxCount: number,
): Promise<void> {
  log(`Checking backup retention (max: ${maxCount})...`);

  const response = await bucket.list({ prefix, maxKeys: 1000 });
  const contents = response.contents ?? [];

  if (contents.length <= maxCount) {
    log(
      `${contents.length} backup(s) found, within retention limit. No cleanup needed.`,
    );
    return;
  }

  // Sort by key ascending (oldest first, since keys contain ISO timestamps)
  const sorted = contents
    .filter((obj) => obj.key.endsWith(".sql.gz"))
    .sort((a, b) => a.key.localeCompare(b.key));

  const toDelete = sorted.slice(0, sorted.length - maxCount);
  log(`Deleting ${toDelete.length} old backup(s)...`);

  for (const obj of toDelete) {
    try {
      await bucket.delete(obj.key);
      log(`  Deleted: ${obj.key}`);
    } catch (err) {
      logError(`  Failed to delete ${obj.key}: ${(err as Error).message}`);
    }
  }

  log("Cleanup completed.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("Starting backup...");

  // 1. Load and validate config
  const config = loadConfig();
  log(
    `Database: ${new URL(config.databaseUrl).hostname}/${new URL(config.databaseUrl).pathname.replace(/^\//, "")}`,
  );
  log(`S3 bucket: ${config.s3Bucket}`);
  log(`Prefix: ${config.backupPrefix}`);
  log(`Retention: ${config.backupMaxCount} backups`);

  // 2. Wait for Postgres to be reachable (serverless may be sleeping)
  await waitForPostgres(config.databaseUrl, config.pgConnectTimeout);

  // 3. Run pg_dump and compress
  const dumpData = await runPgDump(config.databaseUrl);

  if (dumpData.byteLength === 0) {
    throw new Error("pg_dump produced empty output");
  }

  // 4. Upload to S3
  const bucket = createS3Client(config);
  const s3Key = generateS3Key(config.backupPrefix);
  await uploadToS3(bucket, s3Key, dumpData);

  // 5. Cleanup old backups (best-effort – don't fail the run if cleanup fails)
  try {
    await cleanupOldBackups(bucket, config.backupPrefix, config.backupMaxCount);
  } catch (err) {
    logError(`Cleanup failed (non-fatal): ${(err as Error).message}`);
  }

  log("Backup completed successfully.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    logError(`Backup failed: ${(err as Error).message}`);
    if ((err as Error).stack) {
      console.error((err as Error).stack);
    }
    process.exit(1);
  });
