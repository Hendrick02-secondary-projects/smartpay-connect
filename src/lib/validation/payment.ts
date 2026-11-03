import { z } from "zod";
import { parseMznToMinor } from "@/lib/money";
import {
  DEBIT_NOTE_PATTERN,
  MAX_DEBIT_NOTES,
  isValidCustomerName,
  normalizeCustomerName,
  normalizeDebitNoteNumber,
  normalizeMozPhone,
  validateDebitNotes,
} from "@/lib/payments/rules";

export const PAYMENT_METHODS = ["card", "mpesa", "emola"] as const;

const debitNoteSchema = z.object({
  number: z
    .string()
    .max(60)
    .transform(normalizeDebitNoteNumber)
    .refine((v) => DEBIT_NOTE_PATTERN.test(v), "Número de nota de débito inválido (3–40 caracteres: letras, dígitos, - / .)."),
  amount: z
    .string()
    .max(30)
    .transform((v, ctx) => {
      const minor = parseMznToMinor(v);
      if (minor === null || minor <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Valor inválido. Use um valor positivo em MZN, ex.: 2 500,00." });
        return z.NEVER;
      }
      return minor;
    }),
});

/** Public payment intent creation — validated identically on client and server. */
export const createPaymentSchema = z
  .object({
    idempotencyKey: z.string().uuid("Chave de idempotência inválida."),
    bankAccountCode: z.string().min(1, "Seleccione a conta de destino.").max(32),
    customerName: z
      .string()
      .max(200)
      .transform(normalizeCustomerName)
      .refine(isValidCustomerName, "Indique o nome completo do segurado."),
    customerPhone: z
      .string()
      .max(30)
      .transform((v, ctx) => {
        const n = normalizeMozPhone(v);
        if (!n) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Número de telemóvel moçambicano inválido (ex.: 84 123 4567)." });
          return z.NEVER;
        }
        return n;
      }),
    method: z.enum(PAYMENT_METHODS, { errorMap: () => ({ message: "Seleccione o método de pagamento." }) }),
    debitNotes: z.array(debitNoteSchema).min(1, "Adicione pelo menos uma nota de débito.").max(MAX_DEBIT_NOTES),
  })
  .superRefine((data, ctx) => {
    const issue = validateDebitNotes(data.debitNotes.map((n) => ({ number: n.number, amountMinor: n.amount })));
    if (issue.code === "duplicate_number") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["debitNotes", issue.index, "number"], message: "Nota de débito repetida neste pagamento." });
    } else if (issue.code === "total_too_large") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["debitNotes"], message: "O total excede o limite permitido por pagamento." });
    }
  });

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const authorizeSchema = z.object({
  clientSecret: z.string().min(20).max(100),
  scenario: z.enum(["approve", "decline", "insufficient_funds", "pending", "cancel"]),
});

export const resolvePendingSchema = z.object({
  clientSecret: z.string().min(20).max(100),
  resolution: z.enum(["approve", "decline", "cancel"]),
});
