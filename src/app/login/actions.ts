"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { login } from "@/lib/auth/service";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { clientIp } from "@/lib/http";
import { hashIp } from "@/lib/security/crypto";

export interface LoginState {
  error?: string;
}

const schema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
  portal: z.enum(["tenant", "owner"]),
});

/**
 * Server Action: Next.js enforces same-origin for Server Actions (CSRF protection);
 * the session cookie is httpOnly + SameSite=Lax (+ __Host- prefix in production).
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    portal: formData.get("portal"),
  });
  if (!parsed.success) return { error: "Introduza um e-mail e palavra-passe válidos." };

  const h = await headers();
  const result = await login(getDb(), {
    ...parsed.data,
    ipHash: hashIp(clientIp(h)),
    userAgent: h.get("user-agent"),
  });

  if (!result.ok) {
    const messages = {
      invalid_credentials: "Credenciais inválidas.",
      rate_limited: "Demasiadas tentativas. Aguarde alguns minutos e tente novamente.",
      locked: "Conta temporariamente bloqueada por tentativas falhadas. Tente mais tarde.",
    } as const;
    return { error: messages[result.reason] };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  redirect(parsed.data.portal === "owner" ? "/owner/dashboard" : "/finance/dashboard");
}
