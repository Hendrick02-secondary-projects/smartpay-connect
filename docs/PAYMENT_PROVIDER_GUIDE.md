# Guia de integração de um fornecedor de pagamentos real

Na V1 **apenas o `MockPaymentProvider` está activo**. `src/lib/payments/registry.ts` tem
`REAL_PROVIDERS_ENABLED = false` e recusa qualquer `PAYMENT_PROVIDER` diferente de `mock` — mudar uma
variável de ambiente não chega para activar dinheiro real, por desenho.

## 1. Pré-requisitos (bloqueantes)
- [ ] Contrato assinado com o fornecedor autorizado (adquirente de cartões / agregador M-Pesa / e-Mola) e com a seguradora.
- [ ] Modelo de liquidação **confirmado contratualmente** (bruto vs líquido, quem retém a comissão SmartPay, prazos).
- [ ] Credenciais de produção em gestor de segredos (Vercel encrypted env / Vault) — nunca no repositório.
- [ ] Especificação do webhook (formato, assinatura, retries) e do ficheiro de liquidação.
- [ ] Certificação do fornecedor em sandbox concluída, com evidências de testes.
- [ ] Revisão de segurança e, para cartões, confirmação de que o checkout é **hospedado pelo fornecedor** (âmbito PCI DSS SAQ-A).
- [ ] Avaliação regulatória (Banco de Moçambique) concluída.

## 2. Contrato a implementar (`src/lib/payments/provider.ts`)
```ts
interface PaymentProvider {
  name: string; isSimulated: boolean;
  createPayment(input): Promise<{ providerReference; nextAction }>;   // redirect URL / mobile push
  getPaymentStatus(providerReference): Promise<status | null>;        // reconciliação de estados perdidos
  verifyWebhook(rawBody, headers): WebhookVerification;               // assinatura + timestamp → ProviderEvent normalizado
  refundPayment(input): Promise<{ accepted; signedEvent }>;
  getSettlementDetails(request): Promise<GeneratedLine[]>;            // linhas normalizadas de liquidação
}
```
O adaptador **traduz** o formato do fornecedor para `ProviderEvent`. Tudo o resto — máquina de estados,
deduplicação, transacções, comissões, auditoria, dashboards — já existe e não muda.

## 3. Passos
1. Criar `src/lib/payments/providers/<nome>.ts` a implementar `PaymentProvider` (`isSimulated = false`).
2. `verifyWebhook`: validar assinatura com comparação em tempo constante, rejeitar timestamps fora de ±5 min, rejeitar payloads mal formados. Nunca confiar em campos não assinados.
3. Mapear estados do fornecedor para `created | pending | successful | failed | cancelled | reversed`.
4. Criar `src/app/api/webhooks/<nome>/route.ts` a chamar `processProviderWebhook(db, provider, raw, headers)` (ver `api/webhooks/mock`).
5. `createPayment` real: chamar a API **fora** da transacção de BD; guardar `providerReference`; se a chamada falhar, o intent fica `created` e pode ser repetido com a mesma chave de idempotência.
6. Job periódico de `getPaymentStatus` para intents `pending` há mais de N minutos (webhooks perdidos).
7. `getSettlementDetails` / parser do ficheiro real → `importSettlement(...)` com `source: "file_import"`.
8. Actualizar `settlement_batches.feature_status` para `technically_tested` / `contractually_confirmed` apenas com evidência.
9. Registar no `registry.ts` atrás de uma flag de código revista + variável de ambiente; manter mock em Preview.

## 4. Garantias já implementadas no pipeline
| Garantia | Onde |
|---|---|
| Verificação de assinatura + anti-replay por timestamp | `verifyWebhook` |
| Eventos não verificados guardados com id aleatório (não bloqueiam o real) | `processProviderWebhook` |
| Deduplicação (`UNIQUE(provider, event_id)`) | `payment_events` |
| Lock da linha do pagamento (`SELECT … FOR UPDATE`) | `processProviderWebhook` |
| Verificação de valor, moeda e referência | `processProviderWebhook` |
| Transições válidas (app + trigger SQL) | `state-machine.ts`, `smartpay_check_payment_transition` |
| Efeitos atómicos (estado, transacção, comissão, auditoria) | uma transacção de BD |
| Respostas 2xx para duplicados/ignorados (retry-safe) | `api/webhooks/mock` |
