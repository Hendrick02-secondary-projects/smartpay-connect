# Base de dados

O DDL autoritativo está em `drizzle/0000_init.sql` (aplicado por `npm run db:migrate` via migrador Drizzle).
`src/lib/db/schema.ts` espelha-o para tipagem. Para alterações futuras, crie `drizzle/0001_*.sql` e adicione
a entrada em `drizzle/meta/_journal.json` (ou corra `drizzle-kit generate` depois de gerar um snapshot base com
`drizzle-kit pull`).

## Migrações
- `0000_init.sql` — V1.0.
- `0002_neutral_identity.sql` — identidade neutra: só texto de identidade, com backup por valor em `rebrand_backup`. Rollback: `psql "$DATABASE_URL" --single-transaction -f drizzle/rollback/0002_neutral_identity.down.sql`.
- `0001_v11_lifecycle.sql` — V1.1 (aditiva): `kit_allocations`, `payment_closures`, `lifecycle_events`, colunas de reconciliação diferida em `settlement_batches`, `line_kind`/`parent_settlement_id`/`fee_kind` em `bank_settlements`, função idempotente `smartpay_backfill_v11()`.

## Tabelas
`organizations`, `users`, `user_roles`, `sessions`, `rate_limits`, `bank_accounts`, `payment_intents`,
`payment_debit_notes`, `payment_transactions`, `payment_events`, `settlement_batches`, `bank_settlements`,
`reconciliation_records`, `commission_rules`, `commission_entries`, `commission_invoices`,
`commission_invoice_lines`, `commission_payouts`, `audit_logs`, e na V1.1 `kit_allocations`, `payment_closures`, `lifecycle_events`.

## Constraints importantes
| Constraint | Garante |
|---|---|
| `payment_intents_idem_uq (organization_id, idempotency_key)` | sem pagamentos duplicados |
| `payment_intents.reference UNIQUE` | referência global única |
| `pdn_intent_number_uq` | nota de débito não repetida no mesmo pagamento |
| `pt_intent_type_uq` | uma cobrança e uma reversão por pagamento |
| `pe_provider_event_uq` | deduplicação de webhooks |
| `bs_org_ref_uq` (parcial) | referência de liquidação única por tenant |
| `sb_org_file_uq` | o mesmo ficheiro não é importado duas vezes |
| `rr_intent_reconciled_uq` (parcial) | um pagamento é reconciliado por uma só liquidação |
| `ce_one_accrual_per_payment`, `ce_one_reversal_per_payment` | sem comissões duplicadas |
| `cil_entry_uq` | cada entrada do ledger facturada uma vez |
| `user_roles_scope_chk` | papéis de tenant ligados a uma organização; owner sem organização |
| `CHECK amount_minor > 0`, sinais por tipo de entrada | integridade de valores |

## Triggers
- `smartpay_forbid_mutation`: `commission_entries`, `commission_invoice_lines`, `commission_payouts`, `audit_logs`, `bank_settlements`, `payment_transactions`, `payment_debit_notes`, e `DELETE` em `payment_intents`.
- `smartpay_check_payment_transition`: só transições válidas; valor, tenant, referência, conta e método imutáveis.

- `smartpay_check_kit_allocation` (V1.1): transições válidas, versão +1, alocação só com pagamento reconciliado, anulação só com pagamento revertido, bloqueio enquanto a transacção estiver encerrada, sem delete, tenant coerente.
- `smartpay_check_closure` (V1.1): condições de encerramento operacional e financeiro; um encerramento só pode ser reaberto (com motivo), nunca editado nem apagado.
- `smartpay_check_settlement_detail` (V1.1): uma linha de detalhe pertence a um crédito agregado do mesmo lote e tenant.
- `lifecycle_events` só de inserção.

Validado em PostgreSQL 16 com `npm run test:sql` (ver `docs/TEST_REPORT.md`).
