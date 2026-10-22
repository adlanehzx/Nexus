# Beginner's Installation Guide

This guide walks through setting up NEXUS on a fresh machine with minimal terminal usage.

---

## 1. System Prerequisites

Before starting, ensure your system has the following installed:

- **Node.js**: `v22.13.0` or higher (`v24.x` recommended)
- **pnpm**: `v11.x` (`npm install -g pnpm@11.25.0`)
- **Docker & Docker Compose**: v27+ / Compose v2 (recommended for platform isolation)
- **Memory**: 4 GB RAM minimum (8 GB recommended for local agents and vector memory)

Verify prerequisites automatically:

```bash
node -v
pnpm -v
docker compose version
```

---

## 2. One-Command Setup

Clone the repository and run the idempotent interactive setup wizard:

```bash
git clone https://github.com/adlanehzx/Nexus.git nexus
cd nexus
pnpm install

# Run the automated setup wizard
pnpm nexus setup --mode docker
```

### What `nexus setup` does:
1. **Validates prerequisites**: Checks Node version, Docker daemon availability, and port conflicts (3000, 8080, 15432, 6379).
2. **Generates persistent secrets**: Creates `AUTH_SIGNING_KEY` (Ed25519), `MASTER_KEY` (AES-256 vault key), `SEARXNG_SECRET`, and a random `DATABASE_URL` password in `.env` with strict `0600` permissions. Secrets are never printed to the screen.
3. **Discovers Tailscale (optional)**: If Tailscale is active on your host, `nexus setup` detects your tailnet IP and suggests configuring `PUBLIC_API_URL` for secure mobile and remote worker access without port forwarding.

---

## 3. Starting NEXUS

### Recommended: Docker Platform Mode

Run the complete platform (PostgreSQL, Redis, Migrations, API, and Dashboard) in isolated containers:

```bash
pnpm docker:platform
```

Once started:
- **Dashboard**: `http://localhost:8080`
- **Core API**: `http://localhost:3000`
- **Readiness check**: `curl http://localhost:3000/api/v1/health`

### Alternative: Host Development Mode

If you are developing locally with hot reload:

```bash
pnpm docker:infra   # starts postgres & redis
pnpm db:migrate     # applies database schema
pnpm dev            # runs vite and fastify in watch mode
```

---

## 4. First Administrator Account (Onboarding)

NEXUS requires no terminal commands or database seeding to create an administrator account:

1. Open `http://localhost:8080` in your browser.
2. Click **Register** on the sign-in screen.
3. Enter your email and password.
4. **The very first registered user is automatically granted the `ADMIN` role.**
5. All subsequent registrations receive the standard `USER` role and must be approved by the administrator.

---

## 5. Health Diagnostic

Run the automated diagnostic tool at any time to verify installation health:

```bash
pnpm nexus doctor
```

The doctor validates:
- Configuration and persistent keys (signing key, AES-256 master key);
- Database and cache connectivity;
- Agent tools (Codex, Claude, Antigravity CLI detection);
- Network exposure (loopback vs public URL, Tailscale status);
- Systemd and container services.

---

## 6. Next Steps

- **Connect Local Agents**: In the dashboard, open **Connections** and click **Detect installed agents** to discover your local Codex, Claude, or Antigravity CLIs.
- **Add Machines / Workers**: Open **Devices**, generate a single-use pairing code, and scan the QR code from the Android app or run the one-line installer on Windows or Linux.
- **Set Up Web Search**: Start the optional SearXNG container with `pnpm docker:research`.
