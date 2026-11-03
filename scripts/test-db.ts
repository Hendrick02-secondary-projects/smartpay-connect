import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/** Recreates the TEST database schema from migrations before the test suite. */
async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.warn("TEST_DATABASE_URL not set — integration tests will be skipped.");
    return;
  }
  if (url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL (it is wiped).");
  const pool = new Pool({ connectionString: url, max: 1, ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: true } : undefined });
  try {
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.info("✓ Test database ready");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Test DB setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
