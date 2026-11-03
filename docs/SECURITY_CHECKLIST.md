# Segurança e prontidão para produção

## Implementado na V1
- [x] Palavras-passe com bcrypt (custo 12); comparação com hash fictício para e-mails inexistentes (tempo constante).
- [x] Sessões em base de dados: token aleatório de 256 bits no cookie, só SHA-256 guardado; expiração absoluta de 8 h; logout revoga.
- [x] Cookie `httpOnly`, `SameSite=Lax`, `Secure` + prefixo `__Host-` em produção.
- [x] Bloqueio da conta após 5 falhas (15 min) e rate limit de login por IP e por e-mail (em PostgreSQL — funciona em serverless).
- [x] Portais separados: finance não entra em `/owner/login` e vice-versa; `/owner` não aparece na navegação pública e responde 404 a não-owners.
- [x] RBAC no servidor em **cada** página, Server Action e rota API (`requireTenantPage/Api`, `requireOwnerPage/Api`).
- [x] Isolamento de tenant: `organization_id` vem sempre da sessão; todas as queries filtram por ele; testes de isolamento.
- [x] CSRF: Server Actions (verificação de origem do Next.js) + `assertSameOrigin` em todas as rotas API de mutação.
- [x] Validação Zod partilhada cliente/servidor; limites de tamanho de pedidos e ficheiros (2 MB).
- [x] Segredo de capacidade por pagamento (hash na BD, enviado no corpo — nunca no URL) para ver estado/confirmação.
- [x] Webhooks: HMAC-SHA256 + timestamp, comparação em tempo constante, deduplicação.
- [x] Tabelas financeiras e auditoria só-inserção (triggers); transições de estado validadas também na BD.
- [x] Auditoria de login, falhas, criação de pagamentos, mudanças de estado, importações, revisões, regras, facturas, cobranças, exportações.
- [x] IPs guardados apenas como hash com sal; metadados de auditoria com redacção de chaves sensíveis.
- [x] Erros seguros (sem stack/SQL); logs só com classe/mensagem do erro.
- [x] Cabeçalhos: HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy; `noindex`.
- [x] Nenhum dado de cartão pedido, transmitido ou guardado.
- [x] Fornecedores reais desactivados por código (`REAL_PROVIDERS_ENABLED = false`).

## Antes de produção real (não incluído na V1)
- [ ] MFA para finance e owner (TOTP/WebAuthn) e política de palavras-passe com verificação de fugas.
- [ ] Content-Security-Policy com nonces.
- [ ] Gestão de utilizadores pela UI com convites, reset de palavra-passe e revogação de sessões.
- [ ] Papel de BD de aplicação com privilégios mínimos (sem `DELETE` em tabelas financeiras; migrações com outro papel).
- [ ] Row-Level Security no PostgreSQL como segunda barreira de tenant.
- [ ] WAF / protecção de bots no portal público; rate limit na edge.
- [ ] Monitorização, alertas e retenção de logs (sem dados pessoais).
- [ ] Backups/PITR do Neon testados; plano de recuperação.
- [ ] Pentest independente; avaliação PCI DSS (SAQ-A com checkout hospedado).
- [ ] Política de privacidade e tratamento de dados pessoais conforme a legislação moçambicana.
- [ ] Verificação das notas de débito contra o sistema da seguradora (integração KIT — fora da V1).
- [ ] Contratos e confirmação técnica de cada capacidade bancária (ver `/owner/settlements`).
