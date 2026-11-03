import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic edge check only: no cookie -> go to the right login page.
 * REAL authorisation (session validity, role, tenant) happens server-side in
 * every page/route via requireTenantPage / requireOwnerPage / require*Api.
 */
const COOKIE = process.env.NODE_ENV === "production" ? "__Host-sp_session" : "sp_session";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/owner/login") return NextResponse.next();
  const hasSession = request.cookies.has(COOKIE);
  if (!hasSession) {
    if (pathname.startsWith("/finance")) return NextResponse.redirect(new URL("/login", request.url));
    if (pathname.startsWith("/owner")) return NextResponse.redirect(new URL("/owner/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/finance/:path*", "/owner/:path*"],
};
