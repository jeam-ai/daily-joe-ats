import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";

loadEnvConfig(process.cwd());

const connectionString =
  process.env.DATABASE_POOL_URL || process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("DATABASE_URL is required (it is never printed).");
const ca = process.env.AIVEN_CA_CERT?.replaceAll("\\n", "\n");
if (connectionString.includes(".aivencloud.com") && !ca)
  throw new Error(
    "AIVEN_CA_CERT is required for verified TLS (it is never printed).",
  );

const uri = new URL(connectionString);
if (ca) {
  // node-postgres treats URI ssl parameters as overrides for the explicit CA.
  uri.searchParams.delete("sslmode");
  uri.searchParams.delete("sslrootcert");
}

const pool = new Pool({
  connectionString: uri.toString(),
  max: 1,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
  ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
});

async function main() {
  try {
    const [server, size, extensions, relations, constraints] =
      await Promise.all([
        pool.query(
          "SELECT version() AS version, current_setting('max_connections') AS max_connections, current_setting('ssl') AS ssl",
        ),
        pool.query(
          "SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size",
        ),
        pool.query(
          "SELECT name,default_version,installed_version FROM pg_available_extensions WHERE name IN ('pg_cron','pg_stat_statements','uuid-ossp') ORDER BY name",
        ),
        pool.query(
          "SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename",
        ),
        pool.query(
          "SELECT conname,contype FROM pg_constraint WHERE conrelid=to_regclass('public.applications') ORDER BY conname",
        ),
      ]);
    const tableCounts = await Promise.all(
      relations.rows.map(async (row) => {
        const schema = `"${String(row.schemaname).replaceAll('"', '""')}"`;
        const table = `"${String(row.tablename).replaceAll('"', '""')}"`;
        const result = await pool.query(
          `SELECT count(*)::bigint AS count FROM ${schema}.${table}`,
        );
        return {
          schema: row.schemaname,
          table: row.tablename,
          rows: String(result.rows[0]?.count || 0),
        };
      }),
    );
    console.log(
      JSON.stringify(
        {
          connected: true,
          server: server.rows[0],
          storageUsed: size.rows[0]?.database_size,
          extensions: extensions.rows,
          tables: tableCounts,
          applicationConstraints: constraints.rows,
          note: "Confirm the service plan and total storage allocation in Aiven Console; PostgreSQL does not expose provider-plan allocation through SQL.",
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

void main();
