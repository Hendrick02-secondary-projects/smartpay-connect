import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything that can run queries: the root db or an open transaction. */
export type Executor = Database | Tx;

const globalForDb = globalThis as unknown as { __smartpayPool?: Pool; __smartpayDb?: Database };

function createPool(url: string): Pool {
  const needsSsl = /sslmode=require/.test(url) || /neon\.tech/.test(url);
  return new Pool({
    connectionString: url,
    // Serverless-friendly: small pool, short idle timeout (Neon pooled endpoint does the heavy pooling).
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl ? { rejectUnauthorized: true } : undefined,
  });
}

export function getDb(): Database {
  if (globalForDb.__smartpayDb) return globalForDb.__smartpayDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const pool = globalForDb.__smartpayPool ?? createPool(url);
  globalForDb.__smartpayPool = pool;
  globalForDb.__smartpayDb = drizzle(pool, { schema });
  return globalForDb.__smartpayDb;
}

/** Used by tests / scripts to close connections cleanly. */
export async function closeDb(): Promise<void> {
  await globalForDb.__smartpayPool?.end();
  globalForDb.__smartpayPool = undefined;
  globalForDb.__smartpayDb = undefined;
}

export { schema };
