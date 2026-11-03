"use client";

import { useActionState } from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import { loginAction, type LoginState } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";

export function LoginForm({ portal }: { portal: "tenant" | "owner" }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="portal" value={portal} />
      {state.error && <Alert tone="danger" title={state.error} />}
      <div className="space-y-2">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Palavra-passe</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <Button type="submit" className="w-full" size="lg" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <LockKeyhole />}
        {pending ? "A verificar…" : "Entrar"}
      </Button>
    </form>
  );
}
