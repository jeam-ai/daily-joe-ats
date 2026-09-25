import { loadEnvConfig } from "@next/env";
import { transaction } from "../lib/server/database";

loadEnvConfig(process.cwd());

const connectionString =
  process.env.DATABASE_POOL_URL || process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("DATABASE_URL is required (it is never printed).");
const url = new URL(connectionString);
if (!url.hostname.endsWith(".aivencloud.com"))
  throw new Error(
    "Refusing schema initialization: target is not Aiven PostgreSQL.",
  );

// The database layer applies idempotent tables, indexes, and application
// constraints, including removal of the incorrect unique Gmail-thread key.
// This script does not seed applicants, import records, or enable cleanup.
async function main() {
  const result = await transaction(async (tx) =>
    tx.query(
      "SELECT COUNT(*) AS table_count FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
    ),
  );
  console.log(
    JSON.stringify({
      schemaInitialized: true,
      userTableCount: Number(result[0]?.table_count || 0),
      dataImported: false,
      retentionCleanupEnabled: false,
    }),
  );
}

void main();
