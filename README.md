# SmartPay Connect V1.1 — Demonstração

Plataforma B2B de gestão e reconciliação de pagamentos digitais iniciados por QR code.
**Organização de demonstração:** Demo Insurance Company (portal público "SmartPay Payments" em `/pay/demo`). A plataforma é independente de qualquer seguradora: cada seguradora é uma organização com nome, portal, contas, utilizadores e dados próprios.

> ⚠️ **DEMONSTRAÇÃO — PAGAMENTOS SIMULADOS.** Nenhum dinheiro real é processado, nenhum fornecedor de
> pagamentos real é contactado e nenhum dado de cartão é pedido ou guardado. A demonstração não é
> autorizada nem operada por nenhuma seguradora real.

---

## 1. O que está incluído

| Área | Rota | Acesso |
|---|---|---|
| Portal público de pagamento (mobile-first, 6 passos) | `/pay/demo` | Público |
| QR code permanente | `/pay/demo/qr` | Público |
| Estado / confirmação demo do pagamento | `/pay/demo/status/[ref]` | Só no dispositivo que pagou |
| SmartPay Finance Dashboard | `/finance/dashboard`, `/finance/transactions`, `/finance/reconciliation`, `/finance/allocations` (V1.1) | `finance_user` (tenant) |
| Consola SmartPay (owner) | `/owner/dashboard`, `/owner/demo` (V1.1), `/owner/commissions`, `/owner/invoices`, `/owner/settings`, `/owner/settlements`, `/owner/organizations` | `platform_owner` — login em `/owner/login` (não ligado na navegação pública) |

**Novidades V1.1** (ver [CHANGELOG.md](CHANGELOG.md) e [docs/LIFECYCLE.md](docs/LIFECYCLE.md)): alocação no KIT por nota de débito, ciclo de vida em 9 etapas com encerramentos operacional e financeiro independentes, linha temporal persistida, Demo Control Center, liquidação agregada real e reconciliação feita pela Finance.

Stack: Next.js (App Router) · TypeScript strict · Tailwind CSS v4 · componentes estilo shadcn/ui · Lucide · PostgreSQL (Neon) · Drizzle ORM · Zod · Recharts · ExcelJS · qrcode · sessões em base de dados + bcrypt.

## 2. Arquitectura

```
smartpay-connect/
├── drizzle/0000_init.sql          # DDL autoritativo: tabelas, índices, constraints, TRIGGERS
├── scripts/                       # migrate · seed · reset · test-db
├── src/
│   ├── middleware.ts              # verificação optimista de cookie (a autorização real é no servidor)
│   ├── app/
│   │   ├── pay/[org]/             # portal público, QR, estado
│   │   ├── finance/               # área financeira do tenant (layout faz requireTenantPage)
│   │   ├── owner/login            # login do owner (fora do grupo protegido)
│   │   ├── owner/(console)/       # consola owner (layout faz requireOwnerPage) + Server Actions
│   │   └── api/                   # pay/*, webhooks/mock, finance/*, owner/*, qr, auth/logout
│   ├── components/                # ui (primitivas), layout, payment, dashboard, charts
│   └── lib/
│       ├── money.ts               # PURO: minor units, BigInt, ppm, arredondamento half-even
│       ├── payments/              # state-machine (PURO), rules (PURO), provider.ts (interface),
│       │                          # mock-provider.ts, registry.ts, service.ts (pipeline de webhooks)
│       ├── commission/            # engine.ts (PURO) + service.ts (ledger, regras, facturas, cobranças)
│       ├── reconciliation/        # matcher.ts (PURO), parser.ts (PURO), parser-xlsx.ts, service.ts
│       ├── settlement/scenarios.ts# PURO: bruto, líquido, débito de taxas, agregado, reversão
│       ├── auth/                  # policy.ts (PURO RBAC), service.ts, session.ts, password.ts
│       ├── queries/               # read models (todas filtradas por organization_id da sessão)
│       └── reports/excel.ts       # exportações ExcelJS
└── tests/unit · tests/integration
```

Princípios: lógica financeira em **módulos puros** testáveis; efeitos em **transacções de BD**;
regras críticas **duplicadas na base de dados** (triggers/constraints) como defesa em profundidade.

## 3. Desenvolvimento local

Requisitos: Node.js ≥ 20.9, PostgreSQL 15+ (local ou Neon).

```bash
cp .env.example .env          # usado pelos scripts
cp .env.example .env.local    # usado pelo Next.js
# edite DATABASE_URL, TEST_DATABASE_URL e gere segredos:
#   openssl rand -base64 48   -> SESSION_SECRET / MOCK_WEBHOOK_SECRET / IP_HASH_SALT
npm install
npm run db:migrate
npm run db:seed
npm run dev                   # http://localhost:3000
```

`npm run db:reset` apaga e recria tudo (recusa correr em produção; em BD remota exige `CONFIRM_RESET=yes`).

## 4. Utilizadores de demonstração

| Perfil | E-mail | Palavra-passe | Entrar em |
|---|---|---|---|
| Finance Dashboard | `finance@demo-insurance.test` | `SEED_FINANCE_PASSWORD` (default `Finance#Demo2026`) | `/login` |
| Owner SmartPay | `owner@smartpay-demo.test` | `SEED_OWNER_PASSWORD` (default `Owner#Demo2026`) | `/owner/login` |

**Antes de qualquer demonstração partilhada, defina palavras-passe próprias** nas variáveis `SEED_*` e volte a correr o seed.

### Números/cartões de teste (simulador determinístico)
- Móvel (M-Pesa / e-Mola): número terminado em `0001` aprova, `0002` saldo insuficiente, `0003` fica pendente, `0004` cliente cancela. Outros números: escolhe-se o resultado no checkout simulado.
- Cartão: perfis de teste (Aprovado, Recusado, Sem saldo, Pendente/3-DS, Cancelar). **Nunca** há campos de PAN/validade/CVV.

### Guião da demonstração em 3 dispositivos (≈ 12 min)

| Dispositivo | Quem | Abrir em |
|---|---|---|
| 📱 Telemóvel | Cliente (segurado) | `/pay/demo/qr` → ler o QR |
| 💻 Portátil 1 | Finance Dashboard (seguradora) | `/login` → `/finance/dashboard` |
| 💻 Portátil 2 | SmartPay Owner | `/owner/login` → `/owner/demo` |

Os três ecrãs lêem do mesmo PostgreSQL. Os ecrãs da Finance e do Owner actualizam-se sozinhos (indicador "Actualização automática"). Um refresh nunca perde dados.

1. **Cliente:** paga 2 notas de débito (ex.: 6 500 + 3 500 MZN) por M-Pesa com `84 000 0003` (fica **pendente**). A página do telemóvel passa para `/pay/demo/status/<ref>` e aguarda.
2. **Owner (Demo Control Center):** selecciona a transacção → "Confirmar pagamento". O telemóvel mostra "Pagamento simulado concluído" sozinho. A comissão de 50 MZN aparece **apurada**, ainda não facturada nem recebida.
3. **Owner:** "Simular liquidação bancária" com cenário **Liquidação agregada** (um único crédito para vários pagamentos). O lote fica **por reconciliar**.
4. **Finance:** Reconciliação → "Lotes por reconciliar" → **Reconciliar lote**. Em "Ver linhas" vê-se um movimento bancário, as linhas de detalhe, as taxas do gateway e a comissão, cada um em separado.
5. **Finance:** Alocação de Pagamentos → aloca a 1.ª ND (recibo + data). A transacção fica "1/2" e **não** pode ser encerrada. Aloca a 2.ª ND → "Encerrar processo operacional".
6. **Owner:** o processo da seguradora aparece **encerrado** enquanto a comissão ainda está por receber. "Emitir factura simulada" → "Simular recebimento" → "Encerrar processo financeiro". As 9 etapas ficam concluídas e a linha temporal mostra todos os eventos.
7. (Opcional) **Owner:** numa transacção encerrada, "Simular reversão". Os encerramentos reabrem sozinhos e a Finance tem de anular a alocação no KIT.

A base de dados de demonstração já inclui: um cenário completo de 10 000 MZN (todas as etapas concluídas), um lote agregado à espera da Finance, NDs por alocar, alocações parciais e com problema, e transacções encerradas.

## 5. Neon

1. Crie um projecto em neon.tech (região próxima, ex. `aws-eu-central-1`).
2. Crie duas bases: `smartpay` e `smartpay_test` (ou um branch de teste).
3. Use a **connection string pooled** (`-pooler` no host, `?sslmode=require`) em `DATABASE_URL`.
4. Localmente: `npm run db:migrate && npm run db:seed` apontando para o Neon.
O cliente usa `pg` com um pool pequeno (`DB_POOL_MAX`, default 5) — o pooler do Neon faz o resto.

## 6. Vercel

1. Importe o repositório no Vercel (framework: Next.js).
2. Variáveis de ambiente (Production e Preview, valores **diferentes**): `DATABASE_URL`, `APP_URL` (ex. `https://smartpay-demo.vercel.app`), `SESSION_SECRET`, `MOCK_WEBHOOK_SECRET`, `IP_HASH_SALT`, `PAYMENT_PROVIDER=mock`.
3. Corra as migrações antes do primeiro deploy (localmente contra o Neon ou num passo de CI): `npm run db:migrate`.
4. Deploy. O QR code usa `APP_URL` — confirme que corresponde ao domínio final.
5. Não defina `TEST_DATABASE_URL` no Vercel.

## 7. Testes

```bash
npm run typecheck     # tsc --noEmit (strict)
npm run lint          # eslint (next/core-web-vitals + typescript)
npm run test:sql      # recria TEST_DATABASE_URL: migrações + fixture V1.0 + testes de triggers/backfill (só precisa de psql)
npm run test          # recria TEST_DATABASE_URL, corre unitários + integração
npm run test:unit     # só testes puros (não precisam de BD)
npm run build         # build de produção
npm run check         # tudo acima, por ordem
```
Os testes de integração são **ignorados** se `TEST_DATABASE_URL` não estiver definido. Cobrem: login e permissões,
isolamento de tenant, validação, múltiplas notas, totais, idempotência, transições de estado (app + trigger),
comissões, versionamento de regras, reversões, reconciliação, importações duplicadas, exportação Excel,
acesso não autorizado às APIs e CSRF.

## 8. Documentação adicional
- [docs/PAYMENT_PROVIDER_GUIDE.md](docs/PAYMENT_PROVIDER_GUIDE.md) — integrar um fornecedor real
- [docs/COMMISSION_ENGINE.md](docs/COMMISSION_ENGINE.md) — motor de comissões e ledger
- [docs/SECURITY_CHECKLIST.md](docs/SECURITY_CHECKLIST.md) — segurança e prontidão para produção
- [docs/DATABASE.md](docs/DATABASE.md) — schema, constraints e triggers
- [docs/LIFECYCLE.md](docs/LIFECYCLE.md) — ciclo de vida, alocação de pagamentos, encerramentos, liquidação (V1.1)
- [docs/TEST_REPORT.md](docs/TEST_REPORT.md) — testes efectivamente executados e limitações
