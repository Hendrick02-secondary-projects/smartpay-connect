import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function clientIp(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return headers.get("x-real-ip");
}

/**
 * CSRF defence for cookie-authenticated mutation endpoints: the request must come
 * from our own origin (Origin, or Referer as fallback). Server Actions get the same
 * protection from Next.js automatically.
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!host || !origin) throw new HttpError(403, "csrf_rejected", "Pedido rejeitado.");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "csrf_rejected", "Pedido rejeitado.");
  }
  if (originHost !== host) throw new HttpError(403, "csrf_rejected", "Pedido rejeitado.");
}

/** Safe error responses: no stack traces, no SQL, no internals. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status },
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "validation_error",
          message: "Dados inválidos.",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 422 },
    );
  }
  // Log only the error class + message, never request bodies or personal data.
  console.error("[smartpay] unhandled error:", err instanceof Error ? `${err.name}: ${err.message}` : "unknown");
  return NextResponse.json({ error: { code: "internal_error", message: "Ocorreu um erro inesperado. Tente novamente." } }, { status: 500 });
}

export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "payload_too_large", "Pedido demasiado grande.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "JSON inválido.");
  }
}
