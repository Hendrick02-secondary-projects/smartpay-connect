"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import type { ActionState } from "@/app/owner/(console)/actions";
import { cn } from "@/lib/utils";

/** Generic form bound to a Server Action, with pending state and inline result. */
export function ActionForm({
  action,
  submitLabel,
  children,
  className,
  variant = "default",
  confirm,
}: {
  action: (state: ActionState, fd: FormData) => Promise<ActionState>;
  submitLabel: string;
  children?: React.ReactNode;
  className?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form
      action={formAction}
      className={cn("space-y-3", className)}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {state.error && <Alert tone="danger" title={state.error} />}
      {state.ok && <Alert tone="success" title={state.ok} />}
      <Button type="submit" variant={variant} disabled={pending}>
        {pending && <Loader2 className="animate-spin" />}
        {submitLabel}
      </Button>
    </form>
  );
}
