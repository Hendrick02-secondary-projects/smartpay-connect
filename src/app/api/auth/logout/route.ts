import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { revokeSession } from "@/lib/auth/service";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse } from "@/lib/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    await revokeSession(getDb(), token);
    store.delete(SESSION_COOKIE);
    const form = await request.formData().catch(() => null);
    const to = form?.get("to") === "owner" ? "/owner/login" : "/login";
    return NextResponse.redirect(new URL(to, request.url), { status: 303 });
  } catch (err) {
    return errorResponse(err);
  }
}
