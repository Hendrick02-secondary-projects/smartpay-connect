"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CreditCard,
  FileText,
  Loader2,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, FieldError, Input, Label, NativeSelect } from "@/components/ui/primitives";
import { TenantPortalMark } from "@/components/layout/brand";
import { formatMzn, parseMznToMinor, sumMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { createPaymentSchema } from "@/lib/validation/payment";
import { normalizeMozPhone } from "@/lib/payments/rules";
import { METHOD_LABELS, formatPhone } from "@/lib/labels";
import { SimulatedCheckout } from "./simulated-checkout";
import { PaymentResult } from "./payment-result";
import { storeSecret } from "./secret-store";

export interface AccountOption {
  code: string;
  bankName: string;
  accountName: string;
  accountNumberMasked: string;
  purpose: string;
}

type Method = "card" | "mpesa" | "emola";
type Step = 1 | 2 | 3 | 4 | 5 | 6;
type Errors = Record<string, string>;

interface NoteRow {
  key: string;
  number: string;
  amount: string;
}

const STEPS = ["Dados", "Notas de débito", "Método", "Revisão", "Pagamento", "Resultado"] as const;

let rowSeq = 0;
const newRow = (): NoteRow => ({ key: `n${++rowSeq}`, number: "", amount: "" });

export function PaymentFlow({ org, accounts }: { org: { slug: string; portalName: string }; accounts: AccountOption[] }) {
  const [step, setStep] = useState<Step>(1);
  const [accountCode, setAccountCode] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [notes, setNotes] = useState<NoteRow[]>([newRow()]);
  const [method, setMethod] = useState<Method | "">("");
  const [errors, setErrors] = useState<Errors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [payment, setPayment] = useState<{ reference: string; clientSecret: string } | null>(null);
  const [finalStatus, setFinalStatus] = useState<string | null>(null);

  const account = accounts.find((a) => a.code === accountCode) ?? null;
  const totalMinor = useMemo(() => {
    const values = notes.map((n) => parseMznToMinor(n.amount)).filter((v): v is number => v !== null && v > 0);
    return values.length ? sumMinor(values) : 0;
  }, [notes]);

  function payload() {
    return {
      idempotencyKey: idempotencyKey ?? "00000000-0000-4000-8000-000000000000",
      bankAccountCode: accountCode,
      customerName,
      customerPhone,
      method: method || undefined,
      debitNotes: notes.map((n) => ({ number: n.number, amount: n.amount })),
    };
  }

  /** Runs the shared Zod schema and keeps only errors relevant to the given fields. */
  function validate(fields: (path: string) => boolean): boolean {
    const result = createPaymentSchema.safeParse(payload());
    if (result.success) {
      setErrors({});
      return true;
    }
    const next: Errors = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join(".");
      if (fields(path) && !next[path]) next[path] = issue.message;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function goNext() {
    if (step === 1 && validate((p) => ["bankAccountCode", "customerName", "customerPhone"].includes(p))) setStep(2);
    else if (step === 2 && validate((p) => p.startsWith("debitNotes"))) setStep(3);
    else if (step === 3 && validate((p) => p === "method")) {
      // One idempotency key per reviewed payment: retries & double-clicks reuse it.
      setIdempotencyKey(crypto.randomUUID());
      setStep(4);
    }
  }

  async function confirm() {
    if (!validate(() => true) || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/pay/${org.slug}/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Não foi possível criar o pagamento.");
      if (data.clientSecret) {
        storeSecret(data.reference, data.clientSecret);
        setPayment({ reference: data.reference, clientSecret: data.clientSecret });
        // The payment now exists in PostgreSQL: give it a URL so a page reload resumes it
        // (status page reads the capability secret from this tab's sessionStorage).
        window.history.replaceState(null, "", `/pay/${org.slug}/status/${data.reference}`);
      } else if (payment?.reference === data.reference) {
        // idempotent replay of the request we already hold — keep going
      } else {
        throw new Error("Este pagamento já foi criado. Consulte o estado com a referência recebida.");
      }
      setStep(5);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setSubmitting(false);
    }
  }

  const editingLocked = payment !== null;

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-30px)] max-w-lg flex-col px-4 pb-32 pt-5">
      <header className="mb-5 flex items-center justify-between">
        <TenantPortalMark name={org.portalName} />
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
          <ShieldCheck className="size-3.5 text-success" /> Ligação segura
        </span>
      </header>

      <Stepper step={step} />

      <div className="mt-5 flex-1">
        {step === 1 && (
          <Section icon={<UserRound />} title="Dados do segurado" subtitle="Indique para que conta pretende pagar e quem é o segurado.">
            <Field label="Conta de destino" error={errors.bankAccountCode} htmlFor="account">
              <NativeSelect id="account" value={accountCode} onChange={(e) => setAccountCode(e.target.value)} aria-invalid={!!errors.bankAccountCode}>
                <option value="">Seleccione a conta…</option>
                {accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.bankName} · {a.purpose}
                  </option>
                ))}
              </NativeSelect>
              {account && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Building2 className="size-3.5" /> {account.accountName} · {account.accountNumberMasked}
                </p>
              )}
            </Field>
            <Field label="Nome do segurado" error={errors.customerName} htmlFor="name">
              <Input id="name" autoComplete="name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Ex.: Ana Machava" aria-invalid={!!errors.customerName} />
            </Field>
            <Field label="Número de telemóvel" error={errors.customerPhone} htmlFor="phone" hint="Moçambique (+258). Ex.: 84 123 4567">
              <div className="flex">
                <span className="flex items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-sm text-muted-foreground">+258</span>
                <Input
                  id="phone"
                  inputMode="tel"
                  autoComplete="tel-national"
                  className="rounded-l-none"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="84 123 4567"
                  aria-invalid={!!errors.customerPhone}
                />
              </div>
            </Field>
          </Section>
        )}

        {step === 2 && (
          <Section icon={<FileText />} title="Notas de débito" subtitle="Adicione uma ou mais notas de débito que pretende liquidar.">
            <Alert tone="info" className="mb-4">
              Os números das notas de débito são introduzidos por si e <strong>não são verificados</strong> no sistema da seguradora nesta demonstração.
            </Alert>
            {errors.debitNotes && <FieldError>{errors.debitNotes}</FieldError>}
            <div className="space-y-3">
              {notes.map((n, i) => (
                <Card key={n.key} className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Nota {i + 1}</span>
                    {notes.length > 1 && (
                      <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={() => setNotes((xs) => xs.filter((x) => x.key !== n.key))}>
                        <Trash2 /> Remover nota
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-5 gap-3">
                    <div className="col-span-3">
                      <Label htmlFor={`dn-${n.key}`} className="text-xs">
                        Nº da nota de débito
                      </Label>
                      <Input
                        id={`dn-${n.key}`}
                        className="mt-1.5 font-mono uppercase"
                        value={n.number}
                        onChange={(e) => setNotes((xs) => xs.map((x) => (x.key === n.key ? { ...x, number: e.target.value } : x)))}
                        placeholder="DN-2026-0001"
                        aria-invalid={!!errors[`debitNotes.${i}.number`]}
                      />
                      <FieldError>{errors[`debitNotes.${i}.number`]}</FieldError>
                    </div>
                    <div className="col-span-2">
                      <Label htmlFor={`am-${n.key}`} className="text-xs">
                        Valor (MZN)
                      </Label>
                      <Input
                        id={`am-${n.key}`}
                        inputMode="decimal"
                        className="mt-1.5 text-right tabular"
                        value={n.amount}
                        onChange={(e) => setNotes((xs) => xs.map((x) => (x.key === n.key ? { ...x, amount: e.target.value } : x)))}
                        placeholder="0,00"
                        aria-invalid={!!errors[`debitNotes.${i}.amount`]}
                      />
                      <FieldError>{errors[`debitNotes.${i}.amount`]}</FieldError>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
            <Button type="button" variant="outline" className="mt-3 w-full border-dashed" onClick={() => setNotes((xs) => [...xs, newRow()])} disabled={notes.length >= 20}>
              <Plus /> Adicionar nota de débito
            </Button>
          </Section>
        )}

        {step === 3 && (
          <Section icon={<CreditCard />} title="Método de pagamento" subtitle="Todos os métodos usam o gateway simulado.">
            <div className="space-y-3" role="radiogroup" aria-label="Método de pagamento">
              {(
                [
                  { id: "card", icon: <CreditCard />, desc: "Checkout de cartão simulado — nenhum dado de cartão é pedido" },
                  { id: "mpesa", icon: <Smartphone />, desc: "Pedido de confirmação simulado no telemóvel" },
                  { id: "emola", icon: <Smartphone />, desc: "Pedido de confirmação simulado no telemóvel" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={method === m.id}
                  onClick={() => setMethod(m.id)}
                  className={cn(
                    "flex w-full items-center gap-4 rounded-xl border bg-card p-4 text-left transition-all",
                    method === m.id ? "border-primary ring-2 ring-primary/20" : "hover:border-foreground/20",
                  )}
                >
                  <span className={cn("flex size-11 items-center justify-center rounded-lg [&_svg]:size-5", method === m.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                    {m.icon}
                  </span>
                  <span className="flex-1">
                    <span className="block text-sm font-semibold">{METHOD_LABELS[m.id]}</span>
                    <span className="block text-xs text-muted-foreground">{m.desc}</span>
                  </span>
                  <span className={cn("flex size-5 items-center justify-center rounded-full border", method === m.id && "border-primary bg-primary text-white")}>
                    {method === m.id && <Check className="size-3" />}
                  </span>
                </button>
              ))}
            </div>
            <FieldError>{errors.method}</FieldError>
          </Section>
        )}

        {step === 4 && account && method && (
          <Section icon={<Check />} title="Rever e confirmar" subtitle="Confirme que os dados estão correctos antes de pagar.">
            <Card>
              <CardContent className="divide-y p-0 text-sm">
                <ReviewRow label="Segurado" value={customerName} />
                <ReviewRow label="Telemóvel" value={formatPhone(normalizeMozPhone(customerPhone) ?? customerPhone)} />
                <ReviewRow label="Conta de destino" value={`${account.bankName} · ${account.accountNumberMasked}`} sub={account.accountName} />
                <ReviewRow label="Método" value={METHOD_LABELS[method] ?? method} />
                <div className="px-4 py-3">
                  <p className="mb-2 text-xs text-muted-foreground">Notas de débito</p>
                  <ul className="space-y-1.5">
                    {notes.map((n) => (
                      <li key={n.key} className="flex justify-between font-mono text-[13px]">
                        <span>{n.number.trim().toUpperCase()}</span>
                        <span className="tabular">{formatMzn(parseMznToMinor(n.amount) ?? 0)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex items-center justify-between bg-muted/50 px-4 py-4">
                  <span className="font-semibold">Total a pagar</span>
                  <span className="text-lg font-bold tabular">{formatMzn(totalMinor)}</span>
                </div>
              </CardContent>
            </Card>
            {submitError && <Alert tone="danger" title={submitError} className="mt-4" />}
          </Section>
        )}

        {step === 5 && payment && method && (
          <SimulatedCheckout
            orgSlug={org.slug}
            reference={payment.reference}
            clientSecret={payment.clientSecret}
            method={method}
            phone={customerPhone}
            amountMinor={totalMinor}
            onDone={(status) => {
              setFinalStatus(status);
              setStep(6);
            }}
          />
        )}

        {step === 6 && payment && (
          <PaymentResult orgSlug={org.slug} reference={payment.reference} clientSecret={payment.clientSecret} initialStatus={finalStatus} />
        )}
      </div>

      {step <= 4 && (
        <footer className="no-print fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {step > 1 && !editingLocked && (
              <Button variant="outline" size="lg" className="px-4" onClick={() => setStep((s) => (s - 1) as Step)} aria-label="Voltar">
                <ArrowLeft />
              </Button>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total</p>
              <p className="truncate text-base font-bold tabular">{formatMzn(totalMinor)}</p>
            </div>
            {step < 4 ? (
              <Button size="lg" onClick={goNext}>
                Continuar <ArrowRight />
              </Button>
            ) : (
              <Button size="lg" onClick={confirm} disabled={submitting}>
                {submitting ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                {submitting ? "A criar…" : "Confirmar pagamento"}
              </Button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  return (
    <nav aria-label="Progresso" className="flex items-center gap-1.5">
      {STEPS.map((label, i) => {
        const n = (i + 1) as Step;
        const done = n < step;
        const current = n === step;
        return (
          <div key={label} className="flex flex-1 flex-col gap-1.5" aria-current={current ? "step" : undefined}>
            <div className={cn("h-1 rounded-full transition-colors", done || current ? "bg-primary" : "bg-border")} />
            <span className={cn("hidden text-[10px] font-medium sm:block", current ? "text-foreground" : "text-muted-foreground")}>{label}</span>
          </div>
        );
      })}
      <span className="sr-only">
        Passo {step} de {STEPS.length}: {STEPS[step - 1]}
      </span>
    </nav>
  );
}

function Section({ icon, title, subtitle, children }: { icon: React.ReactNode; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-5 flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&_svg]:size-[18px]">{icon}</span>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Field({ label, error, htmlFor, hint, children }: { label: string; error?: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      <div className="mt-2">{children}</div>
      {hint && !error && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
      <FieldError>{error}</FieldError>
    </div>
  );
}

function ReviewRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">
        {value}
        {sub && <span className="block text-xs font-normal text-muted-foreground">{sub}</span>}
      </span>
    </div>
  );
}
