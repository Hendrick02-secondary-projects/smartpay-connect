# Changelog

## 1.1.2 — 2026-11-03 · Nome do módulo de alocação

### Alterado
- O nome visível "Alocação KIT" / "Alocação no KIT" passa a **"Alocação de Pagamentos"**: menu da Finance, título da página e do separador, diálogo de alocação, filtro das transacções, etapa 4 do ciclo de vida, linha temporal e Demo Control Center.
- Só texto da interface e documentação. Rotas (`/finance/allocations`), tabela `kit_allocations`, permissão `tenant:kit:allocate`, chave de etapa `kit_allocation` e dados gravados ficam iguais, por isso não há migração. O campo "Nº do recibo KIT" mantém o nome, porque identifica o recibo emitido pelo sistema KIT da seguradora.

## 1.1.1 — 2026-11-03 · Identidade independente

### Alterado
- Toda a referência à seguradora usada anteriormente na demonstração foi removida do código, interface, dados de demonstração, testes e documentação. A plataforma usa só a identidade **SmartPay Connect**.
- Rotas: portal público `/pay/demo` (QR code incluído); área financeira `/finance/*` (antes com o nome da seguradora); APIs `/api/finance/*`.
- Nomenclatura: "SmartPay Payments" (portal), "Finance Dashboard" / "SmartPay Finance Dashboard" (área financeira), "SmartPay Demo".
- Organização de demonstração: **Demo Insurance Company** (slug `demo`). Utilizador demo: `finance@demo-insurance.test`.
- Identidade visual: paleta própria SmartPay (azul-índigo sobre neutros frios), em vez da cor associada à seguradora anterior. Componentes, layouts e funcionalidades sem alterações.
- O nome da organização na área financeira passa a vir da base de dados (nenhuma seguradora fixa no código).
- Novas referências de pagamento usam o prefixo `SPC` (SmartPay Connect). As referências já existentes são imutáveis e mantêm-se.

### Migração
- `drizzle/0002_neutral_identity.sql`: actualiza só o texto de identidade dos dados já gravados e guarda cada valor antigo em `rebrand_backup`. É reversível com `drizzle/rollback/0002_neutral_identity.down.sql`. Não toca em valores, estados, referências nem relações, e regista-se no `audit_logs`, que não é reescrito.

## 1.1.0 — 2026-11-03

### Novo
- **Alocação no KIT** (Finance Dashboard → Alocação KIT e detalhe da transacção). Cada nota de débito tem estado próprio, nº do recibo, data, utilizador responsável e observações. A transacção só fica totalmente alocada quando todas as NDs estão alocadas.
- **Ciclo de vida em 9 etapas**, calculado a partir dos factos, com **encerramento operacional (seguradora)** e **encerramento financeiro (SmartPay)** independentes, reabertura com motivo e reabertura automática após reversão.
- **Linha temporal persistida** (`lifecycle_events`, só de inserção e idempotente) no detalhe da transacção da seguradora (só etapas operacionais) e no Demo Control Center (todas as etapas).
- **Demo Control Center** (`/owner/demo`): eventos simulados de pagamento, liquidação bancária, facturação e recebimento da comissão, e encerramento financeiro. Sem acções de reconciliação nem de alocação (permissões da Finance).
- Actualização automática (pausável) nas páginas usadas na demo em 3 dispositivos. O portal do cliente retoma o pagamento depois de um refresh e acompanha um pagamento pendente.
- `npm run test:sql`: suite SQL com fixture de dados V1.0 (migração + backfill + triggers).

### Alterado
- A liquidação recebida do fornecedor fica **por reconciliar** até a Finance a reconciliar. A importação de ficheiros pela Finance continua a reconciliar de imediato.
- `aggregated` gera agora **um único crédito bancário** com linhas de detalhe por pagamento. A reconciliação verifica que a soma bate certo.
- `separate_fee_debit` gera **dois débitos**: taxa do gateway e comissão SmartPay.
- O matcher verifica a aritmética do valor líquido. Os totais de liquidação separam movimento bancário, taxa do gateway e comissão sem contar duas vezes os agregados.
- Novas permissões: `tenant:kit:allocate`, `tenant:operations:close`, `platform:demo:control`, `platform:financial:close`.

### Migração
- `drizzle/0001_v11_lifecycle.sql` é aditiva: nenhuma tabela, coluna ou linha V1.0 é removida. Os lotes V1.0 ficam marcados como já reconciliados. As alocações e a linha temporal dos pagamentos existentes são reconstruídas por `smartpay_backfill_v11()`.
