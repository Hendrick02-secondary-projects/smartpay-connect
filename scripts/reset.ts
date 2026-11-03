import "dotenv/config";
import { Pool } from "pg";

/** DESTRUCTIVE: drops every SmartPay table. Refuses to run against production. */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
    throw new Error("Refusing to reset a production database.");
  }
  if (process.env.CONFIRM_RESET !== "yes" && !/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error("Remote database detected. Re-run with CONFIRM_RESET=yes if you really want to wipe it.");
  }
  const pool = new Pool({ connectionString: url, max: 1, ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: true } : undefined });
  try {
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    console.info("✓ Database reset");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Reset failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
