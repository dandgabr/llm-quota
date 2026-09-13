# llm-quota — Deploy com Containers (Docker & Podman)

Este diretório contém a infraestrutura necessária para rodar o **llm-quota** completo (PostgreSQL com isolamento RLS, API Hono e SPA Web/Nginx) em contêineres de forma reproduzível em qualquer servidor externo.

---

## 1. Pré-requisitos
- **Docker** (com `docker compose`) ou **Podman** (com `podman-compose`).
- OpenSSL (para gerar chaves criptográficas seguras).

---

## 2. Configuração Rápida (Passo a Passo)

### 2.1 Preparar o arquivo de ambiente (.env)
Copie o modelo de ambiente:
```bash
cp docker/.env.example docker/.env
```

Gere as chaves criptográficas necessárias e preencha no `docker/.env`:
```bash
# 1. KEK para envelope de criptografia das chaves de API (32 bytes base64)
openssl rand -base64 32

# 2. Secret de sessão do usuário
openssl rand -hex 32

# 3. Peppers para proteção de senhas e recuperação MFA
openssl rand -base64 32
openssl rand -base64 32

# 4. Senhas do PostgreSQL (Superuser e App Role com isolamento RLS)
openssl rand -hex 16
openssl rand -hex 16
```

Preencha no `docker/.env`:
```dotenv
POSTGRES_USER=llmquota
POSTGRES_PASSWORD=<senha-gerada-1>
POSTGRES_DB=llm_quota
POSTGRES_APP_PASSWORD=<senha-gerada-2>

LLM_QUOTA_KEK=<chave-base64-gerada>
SESSION_SECRET=<secret-gerado>
AUTH_PEPPER=<pepper-1-gerado>
RECOVERY_PEPPER=<pepper-2-gerado>
WEB_ORIGIN=https://seu-dominio.com
```

---

## 3. Subir o Ambiente

### Modo Padrão (API + Web + PostgreSQL)
```bash
# Com Docker:
docker compose -f docker/compose.yaml up -d --build

# Ou com Podman:
podman-compose -f docker/compose.yaml up -d
```

### Inicialização do Banco de Dados (Migração e Seed Inicial)
Na primeira execução, inicialize as tabelas do banco:
```bash
# Via container da API:
docker compose -f docker/compose.yaml exec api pnpm --filter @llm-quota/db migrate
docker compose -f docker/compose.yaml exec api pnpm --filter @llm-quota/db seed
```

---

## 4. Portas e Acesso
- **Web SPA**: Porta `8080` (configurável via `WEB_HTTP_PORT`).
- **API REST**: Porta `3000` (interna, roteada via Nginx ou ingress).
- **PostgreSQL**: Porta `5432` restrita à rede interna privada (`internal`).
