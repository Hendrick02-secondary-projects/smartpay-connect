# Motor de comissões

```
commission = eligible_payment_amount × contracted_rate
```

## Representação numérica
- Valores: **inteiros em unidades mínimas** (centavos) — `BIGINT` na BD, `number` seguro em TS.
- Taxas: **inteiros em ppm** (partes por milhão). 0,5% = `5 000` ppm. Permite 4 casas decimais de percentagem.
- Cálculo: `BigInt(amount) × BigInt(ppm) / 1 000 000` com **arredondamento bancário** (half-even). Sem floats em lado nenhum.
- Exemplo: 10 000,00 MZN = 1 000 000 centavos × 5 000 ppm ÷ 1 000 000 = **5 000 centavos = 50,00 MZN**.

## Regras (`commission_rules`)
Campos: organização, `version`, `rate_ppm`, `effective_from`, `effective_to`, `status`, `contract_reference`, notas.
- Uma nova versão tem de começar **no futuro** e depois da versão actual → sem efeitos retroactivos.
- Ao publicar, a versão anterior é fechada em `effective_to = novo início` (fica no histórico).
- Alterações serializadas por organização (`pg_advisory_xact_lock`) e auditadas.

## Elegibilidade e snapshot
Um pagamento torna-se elegível quando passa a `successful`. Na **mesma transacção** que muda o estado,
`accrueCommission` selecciona a regra em vigor nesse instante e grava no ledger: `rule_id`, `rule_version`,
`rate_ppm` e `base_amount_minor`. Mudar a regra depois **nunca** altera essa entrada.

## Ledger imutável (`commission_entries`)
| Tipo | Sinal | Regras |
|---|---|---|
| `accrual` | ≥ 0 | no máximo uma por pagamento (`ce_one_accrual_per_payment`) |
| `adjustment` | ± | motivo obrigatório |
| `reversal` | ≤ 0 | no máximo uma por pagamento; `compensates_entry_id` aponta para a acumulação |

Trigger `smartpay_forbid_mutation` bloqueia `UPDATE`/`DELETE`. Correcções = novas entradas compensatórias.
Reversão de pagamento → entrada `reversal` = −(soma do que estava registado) → líquido do pagamento volta a 0.

## Ciclo de vida (derivado, nunca editado)
`accrued → adjusted → invoiced → partially_paid → paid` ou `reversed`.
- **Acumulada ≠ cobrada.** Só uma `commission_payouts` (cobrança registada contra uma factura) torna uma comissão "paga".
- Facturas (`commission_invoices` + `commission_invoice_lines`): cada entrada do ledger só pode ser facturada uma vez (`cil_entry_uq`).
- Cobranças: não podem exceder o valor em dívida; estado da factura recalculado (`invoiceStatusFor`).
- V1: facturas e cobranças são simuladas/manuais. Partilha de receita pelo gateway exigirá configuração contratual e eventos de liquidação verificados.

## KPIs da consola
- Bruta acumulada = Σ accruals · Ajustes = Σ adjustments + reversals · Líquida devida = Σ ledger
- Facturado = Σ facturas não anuladas · Cobrado = Σ payouts · Em dívida = líquida − cobrado
