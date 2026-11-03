# Ciclo de vida da transacção (V1.1)

## As nove etapas

| # | Etapa | Lado | Quem executa | Facto que a conclui |
|---|---|---|---|---|
| 1 | Pagamento confirmado | Seguradora | Fornecedor (simulado) | webhook `payment.succeeded` verificado |
| 2 | Liquidação bancária | Seguradora | Banco/fornecedor (simulado) | linha de crédito (ou de detalhe de um crédito agregado) com a referência do pagamento |
| 3 | Reconciliação | Seguradora | **Finance** | `reconciliation_status` = reconciled / manually_reconciled |
| 4 | Alocação de Pagamentos | Seguradora | **Finance** | **todas** as `kit_allocations` do pagamento em `allocated` |
| 5 | Encerramento operacional da seguradora | Seguradora | **Finance** | `payment_closures(kind='operational')` aberto |
| 6 | Comissão apurada | SmartPay | Sistema | entrada `accrual` no ledger |
| 7 | Comissão facturada | SmartPay | Owner | todas as entradas do pagamento em facturas |
| 8 | Comissão recebida | SmartPay | Owner (registo simulado) | todas essas facturas `paid` |
| 9 | Encerramento financeiro SmartPay | SmartPay | Owner | `payment_closures(kind='financial')` aberto |

As etapas **não são guardadas como estados**: `src/lib/lifecycle/stages.ts` calcula-as sempre a partir dos factos, por isso nunca ficam desalinhadas dos registos. Os dois encerramentos são **independentes**: a seguradora pode encerrar antes de a SmartPay receber a comissão, e o contrário também é possível.

## Regras de encerramento
- **Operacional:** o pagamento tem de estar bem-sucedido, reconciliado e com todas as NDs alocadas. Se o pagamento foi revertido, todas as alocações têm de estar anuladas.
- **Financeiro:** todas as entradas de comissão do pagamento estão em facturas pagas, ou a comissão está anulada (líquido 0 e nada facturado).
- Para reabrir é obrigatório indicar um motivo (mín. 10 caracteres). Um encerramento reaberto nunca é editado: um novo encerramento cria uma linha nova.
- Uma **reversão** reabre automaticamente os dois encerramentos (actor: sistema) e anula as NDs ainda não alocadas. As NDs já alocadas ficam "Alocada" até a Finance registar a anulação no KIT.
- As mesmas regras estão no código (`canCloseOperational`/`canCloseFinancial`) e no trigger `smartpay_check_closure`.

## Alocação de Pagamentos (`kit_allocations`)
- Uma linha por Nota de Débito, criada quando o pagamento fica bem-sucedido.
- Transições: `pending → allocated | issue`, `issue → allocated | pending`, `allocated → pending` (anular alocação), qualquer uma `→ voided`, mas só se o pagamento foi revertido.
- `allocated` exige nº do recibo KIT, data (não futura, não anterior ao pagamento) e utilizador. `issue`, `pending` (por anulação) e `voided` exigem motivo.
- O mesmo recibo não pode servir duas transacções diferentes.
- Concorrência: cada alteração envia `expectedVersion`. Se outro utilizador alterou primeiro, a resposta é 409, e o trigger também exige `version = version + 1`.
- Enquanto a transacção estiver encerrada operacionalmente, não é possível alterar alocações.

## Linha temporal (`lifecycle_events`)
- Tabela só de inserção. Cada evento tem `dedupe_key` com a chave natural do facto (`payment:<id>:successful`, `settlement:<linha>`, `kit:<alocação>:v<versão>`, …), por isso webhooks repetidos e backfills nunca duplicam eventos.
- A seguradora vê só as etapas operacionais. O owner (Demo Control Center) vê todas.
- A migração `0001` reconstrói a linha temporal dos dados V1.0 com `smartpay_backfill_v11()`, que é idempotente.

## Liquidação bancária (V1.1)
- Uma liquidação **recebida** do fornecedor fica no lote em estado `pending`. Só a Finance a **reconcilia** (botão "Reconciliar lote"). Receber dinheiro e reconciliá-lo são etapas distintas.
- Cada linha separa três coisas: o movimento bancário da seguradora (só linhas `statement`), a taxa do gateway e a comissão SmartPay.

| Cenário | Movimentos no extracto | Taxas |
|---|---|---|
| `gross` | 1 crédito bruto por pagamento | facturadas à parte |
| `net` | 1 crédito líquido por pagamento (bruto − taxa − comissão) | deduzidas na origem |
| `separate_fee_debit` | 1 crédito bruto por pagamento + 1 débito da taxa do gateway + 1 débito da comissão SmartPay | debitadas em separado |
| `aggregated` | **1 único crédito** para N pagamentos + N linhas de detalhe (não são movimentos) | facturadas à parte |
| `reversal` | 1 débito de reversão por pagamento | — |

- No cenário agregado, um pagamento só fica reconciliado se a sua linha de detalhe coincidir **e** a soma das linhas de detalhe for igual ao crédito. Caso contrário, todas as linhas ficam em revisão (`AGGREGATE_UNBALANCED`).
- O valor líquido tem de ser o bruto ou o bruto menos as taxas (`NET_ARITHMETIC_MISMATCH`).
- Ficheiros importados aceitam as colunas opcionais `line_kind`, `parent_reference` e `fee_kind`. Os ficheiros V1.0 continuam válidos.
- Os lotes V1.0 do cenário `aggregated` foram gravados linha a linha, como na V1.0, e mantêm-se assim. A tabela de liquidações é só de inserção.
