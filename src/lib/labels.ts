export const METHOD_LABELS: Record<string, string> = {
  card: "Visa / Mastercard",
  mpesa: "M-Pesa",
  emola: "e-Mola",
};

export function formatDateTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("pt-MZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Maputo",
  }).format(date);
}

export function formatDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("pt-MZ", { dateStyle: "medium", timeZone: "Africa/Maputo" }).format(date);
}

/** Masks a phone for list views: +258 84 ••• 4567 */
export function maskPhone(phone: string): string {
  const m = /^\+258(\d{2})(\d{3})(\d{4})$/.exec(phone);
  return m ? `+258 ${m[1]} ••• ${m[3]}` : phone;
}

export function formatPhone(phone: string): string {
  const m = /^\+258(\d{2})(\d{3})(\d{4})$/.exec(phone);
  return m ? `+258 ${m[1]} ${m[2]} ${m[3]}` : phone;
}

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  created: "Criado",
  pending: "Pendente",
  successful: "Bem-sucedido",
  failed: "Falhado",
  cancelled: "Cancelado",
  reversed: "Revertido",
};

export const RECON_STATE_LABELS: Record<string, string> = {
  unreconciled: "Por reconciliar",
  reconciled: "Reconciliado",
  exception: "Excepção",
  manually_reconciled: "Reconciliado (manual)",
};

export const LIFECYCLE_LABELS: Record<string, string> = {
  accrued: "Acumulada",
  adjusted: "Ajustada",
  invoiced: "Facturada",
  partially_paid: "Parcialmente paga",
  paid: "Paga",
  reversed: "Revertida",
};
