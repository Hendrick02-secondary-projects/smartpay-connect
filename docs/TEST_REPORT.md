# Relatório de testes — SmartPay Connect

Este relatório separa o que **foi executado** do que **não pôde ser executado**, e explica porquê.

## Ambiente de execução
- PostgreSQL 16.15 local (bases `smartpay` e `smartpay_test`).
- Node.js 22, TypeScript (compilador global), `tsx`.
- **Registry npm bloqueado** nesta sessão (proxy responde 403 a `registry.npmjs.org`). Não foi possível instalar `next`, `drizzle-orm`, `pg`, `eslint`, `vitest`, `exceljs`, `recharts`, `@radix-ui/*` nem `lucide-react`.
- Disponíveis localmente e usados: `zod` 3.25.76 (a mesma versão do `package.json`), `@types/node`, `clsx`, `tailwind-merge`, `class-variance-authority`.
- Os testes `tests/unit/*.test.ts` correram através de um adaptador local mínimo que expõe a API do vitest sobre `node:test`. O adaptador fica só no ambiente local e não é entregue: o projecto continua a usar o vitest real.

## 1. Baseline V1.0 — antes de qualquer alteração (2026-11-03)

| Verificação | Comando | Resultado |
|---|---|---|
| Testes unitários | `tests/unit/*.test.ts` (5 ficheiros) | ✅ **44 passaram, 0 falharam** |
| Typecheck strict (parcial) | `tsc` sobre os 14 módulos sem dependência de next/drizzle/pg/react | ✅ **0 erros** |
| Testes SQL (migração + triggers) | `npm run test:sql` → `010_v10_invariants.sql` | ✅ **17 asserções passaram** |
| Typecheck completo | `npm run typecheck` | ⛔ não executado (dependências não instaláveis) |
| Lint | `npm run lint` | ⛔ não executado (eslint não instalável) |
| Testes de integração | `npm run test:integration` | ⛔ não executado (drizzle-orm/pg/vitest não instaláveis) |
| Build de produção | `npm run build` | ⛔ não executado (next não instalável) |

Os 17 testes SQL da V1.0 cobrem: idempotência, transições de estado válidas e inválidas, imutabilidade do valor, proibição de apagar pagamentos, comissão duplicada, sinal das reversões, ledger e auditoria só de inserção, e o âmbito dos papéis.

## 2. V1.1 — depois das alterações (2026-11-03)

| Verificação | Resultado |
|---|---|
| Testes unitários (8 ficheiros) | ✅ **69 passaram, 0 falharam** (eram 44; +25 novos) |
| Typecheck strict (parcial, 16 módulos) | ✅ **0 erros** — inclui `lifecycle/stages.ts` e `kit/allocation.ts` |
| Sintaxe de **todos** os ficheiros TS/TSX | ✅ **136 ficheiros, 0 erros de sintaxe** (parser do TypeScript, sem resolução de módulos) |
| Testes SQL (`npm run test:sql`) | ✅ **66 asserções passaram** em 3 ficheiros |
| Migração 0000 + 0001 numa única transacção sobre base vazia (caminho do migrador Drizzle) | ✅ 22 tabelas; backfill idempotente |
| Migração 0001 sobre **dados V1.0 existentes** (fixture) | ✅ dados preservados; 5 alocações e 22 eventos reconstruídos |
| Typecheck completo · Lint · Integração · Build | ⛔ **não executados** — npm bloqueado (ver abaixo) |

### Testes novos executados
- **Unitários (25):** regras de alocação de pagamentos (estado, recibo, datas, motivo, anulação só com reversão, bloqueio após encerramento, "totalmente alocada só com todas as NDs"); derivação das 9 etapas e encerramentos independentes ("acumulada ≠ recebida", reversão, pagamentos falhados); liquidação agregada (1 crédito + N detalhes, soma desequilibrada, detalhe órfão, aritmética do líquido, separação de taxas por cenário, parser com colunas V1.1).
- **SQL (49 novas asserções):** preservação e backfill dos dados V1.0, idempotência do backfill, linha temporal só de inserção, transições KIT no trigger, versão optimista, alocação antes da reconciliação recusada, alocação entre tenants recusada, encerramento com alocação parcial recusado, encerramento único, congelamento das alocações após encerramento, reabertura só com motivo e definitiva, encerramento financeiro só com comissão recebida ou anulada, encerramento de pagamento falhado ou de outro tenant recusado, linhas de detalhe só sob crédito agregado do mesmo lote.
- Os 17 testes SQL da V1.0 continuam a passar depois da migração 0001.

### Testes escritos mas NÃO executados (precisam de `npm install`)
- `tests/integration/v11-lifecycle.test.ts` (16 casos): alocação de pagamentos ponta a ponta, conflito de versão entre dois utilizadores, recibo reutilizado, encerramentos independentes, reversão após encerramento, liquidação pendente até à Finance, crédito agregado, pagamentos e webhooks duplicados sem eventos duplicados, linha temporal por audiência, isolamento entre tenants, owner sem acesso às acções da Finance (403) e Finance sem acesso ao encerramento financeiro (403).
- Os 22 testes de integração da V1.0 (`payments`, `commission-reconciliation`, `auth-api`).

### Testes ajustados (não removidos)
- `reconciliation-matcher.test.ts`: o teste de `separate_fee_debit` passou a esperar **dois** débitos (gateway e SmartPay), como pede a V1.1. Antes havia um único débito combinado. A comparação de totais passou de `toEqual` para `toMatchObject`, porque `settlementTotals` devolve agora campos adicionais (movimentos bancários, deduções, débitos). Os valores verificados são os mesmos.

### Riscos conhecidos até correr `npm run check`
O código que depende de `next`, `drizzle-orm`, `pg` e `react` foi escrito sem compilador. É provável que o primeiro `npm run typecheck` aponte alguns erros de tipos, por exemplo assinaturas da API Drizzle como `.for("update", { of })` e `selectDistinct`, ou tipos de `sql<>`. A lógica de domínio que esse código usa está testada. As regras críticas estão também na base de dados (testadas).

**Antes de produção:** `npm install && npm run check` (typecheck → lint → test:sql → test → build) e corrigir o que aparecer.

## 3. V1.1.1 — remoção da marca da seguradora anterior (2026-11-03)

| Verificação | Resultado |
|---|---|
| Pesquisa da marca (sem distinguir maiúsculas; código, comentários, testes, seed, docs, metadados) | ✅ **0 ocorrências** fora de 3 ficheiros que têm de conter o nome antigo para o substituir: a migração `0002_neutral_identity.sql`, a fixture com os dados antigos e o teste que prova a conversão |
| Abreviatura antiga e códigos de bancos reais nos dados de demo/testes | ✅ 0 (referências novas `SPC-…`, contas `DEMO-…`) |
| Rotas (verificação estática do App Router) | ✅ 37 rotas; **55 usos** de URL (`href`, `fetch`, `redirect`, `action`) e **93 literais** de caminho interno, todos com rota existente |
| QR code → `/pay/demo` | ✅ teste unitário `portal.test.ts`; a organização demo tem o slug `demo` (seed e migração) |
| Dados existentes não perdidos | ✅ teste SQL `040_neutral_identity.sql`: contagens de pagamentos e eventos preservadas; referência, valor, estados, ledger, códigos de conta e versão das alocações intactos |
| Migração reversível | ✅ o mesmo teste aplica o rollback e confirma que os valores originais (incluindo jsonb) voltam e os triggers voltam a ficar activos |
| Testes unitários | ✅ **71/71** (+2 novos). Um erro de substituição introduzido nesta tarefa foi apanhado por um teste e corrigido |
| Typecheck strict (parcial) | ✅ 17 módulos, 0 erros |
| Testes SQL | ✅ **89 asserções**, 0 falhas |
| Sintaxe de todos os TS/TSX | ✅ 138 ficheiros, 0 erros |
| Migrações 0000→0002 numa transacção sobre base vazia | ✅ 23 tabelas; a 0002 não altera nada quando não há dados antigos |
| Diff com a versão anterior | ✅ as únicas linhas de código alteradas são identidade, rotas, prefixo das referências, título do portal lido da base de dados e URL do QR (mesmo resultado) |
| Typecheck completo · Lint · Integração · **Build** | ⛔ **não executados**: npm continua bloqueado nesta sessão |
