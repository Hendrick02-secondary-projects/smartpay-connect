import "server-only";
import { sql } from "drizzle-orm";
import type { Executor } from "@/lib/db";

/**
 * Fixed-window rate limiter stored in PostgreSQL so it works across serverless
 * instances (no in-memory state on Vercel). One atomic upsert per check.
 */
export async function consumeRateLimit(
  db: Executor,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const result = await db.execute<{ count: number; window_start: Date }>(sql`
    INSERT INTO rate_limits (key, count, window_start)
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   THEN now() ELSE rate_limits.window_start END
    RETURNING count, window_start
  `);
  const row = result.rows[0];
  const count = Number(row?.count ?? 1);
  const started = row?.window_start ? new Date(row.window_start).getTime() : Date.now();
  const retryAfterSeconds = Math.max(1, Math.ceil((started + windowSeconds * 1000 - Date.now()) / 1000));
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
}
