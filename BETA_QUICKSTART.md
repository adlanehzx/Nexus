# NEXUS — Beta Quick Start Guide

Welcome to the Beta version of **NEXUS**, the autonomous multi-agent workstation and orchestration platform.

---

## 1. System Requirements

- **Operating system**: Linux (Ubuntu, Debian, Fedora, Arch) or macOS / WSL2
- **Docker & Docker Compose**: Docker v24+ and Docker Compose v2+
- **Recent web browser**: Chrome, Firefox, Safari or Edge
- **AI agents (optional but recommended)**:
  - CLI tools installed on the host machine (`claude`, `codex`, or `agy`)
  - **OR** a cloud API key (Anthropic, OpenAI, Gemini, Mistral, OpenRouter)
  - **OR** the built-in free cloud models (NVIDIA NIM / Llama 3)

---

## 2. One-Command Startup

From the repository root:

```bash
bash scripts/quickstart.sh
```

This script automatically performs:

1. Docker and Docker Compose verification.
2. Detection of locally installed CLI binaries (`claude`, `codex`, `agy`).
3. Generation of the Ed25519 cryptographic keys and the secure vault (`MASTER_KEY`).
4. Startup of the container stack (`nexus-api`, `nexus-web`, `postgres`, `redis`, etc.).
5. Validation of the health probe at `http://127.0.0.1:8080/healthz`.

---

## 3. Accessing the Dashboard

Once startup is confirmed:

| Access mode             | URL                                                          | Description                                 |
| :---------------------- | :----------------------------------------------------------- | :------------------------------------------ |
| **Local**               | [http://localhost:8080](http://localhost:8080)               | Direct access from your machine             |
| **Network / Tailscale** | `http://<YOUR_TAILSCALE_IP>:8080`                            | Secure remote access (e.g. mobile / laptop) |
| **Backend API**         | [http://localhost:8080/api/v1](http://localhost:8080/api/v1) | REST & OpenAPI endpoints                    |

---

## 4. First-Run Assistant (Setup Wizard)

On your first visit, you will be guided by the interactive 5-step assistant:

1. **Local administrator account**: Set your email address and a strong password. Your credentials stay strictly stored on your local server.
2. **Infrastructure & data**: Secure initialization of the PostgreSQL database and the Redis cache.
3. **Connecting AI agents**:
   - **Local CLI detection**: If you already use `claude code`, `codex` or `antigravity`, NEXUS detects your profiles without ever asking for your passwords.
   - **Cloud alternative**: If no CLI is installed, simply click _"Continue with cloud LLMs"_ to use the built-in models or configure your API keys.
4. **Optional capabilities**: Headless browser automation (CDP) and MCP servers.
5. **Validation & smoke test**: Live test of the orchestration chain before reaching the dashboard.

---

## 5. Main Features Available in Beta

- **Orchestrated NEXUS Chat**: Multi-agent conversational assistant with direct streaming, guided suggestions and intelligent task routing.
- **Worktree management & VCS checkpoints**: Create, inspect and merge (_handoff_) your Git worktrees and roll back checkpoints without blocking the browser.
- **Mission & task engine**: Tracking of running tasks, safe cancellation and automated scheduling (Cron).
- **Agent profile management**: View, configure and directly test ACP adapters.
- **MCP catalog**: Centralized connection and management of Model Context Protocol tool servers.
- **Dual view**: Classic Dashboard by default for maximum productivity, with a smooth switch to the immersive 3D Spatial OS (`Alt+O`).

---

## 6. Main Keyboard Shortcuts

| Shortcut | Action                                             |
| :------- | :------------------------------------------------- |
| `Alt+1`  | Open the Orchestrated Chat                         |
| `Alt+2`  | Overview (Supervision)                             |
| `Alt+3`  | Task Tracking                                      |
| `Alt+4`  | Mission Engine                                     |
| `Alt+5`  | Agent Management                                   |
| `Alt+6`  | MCP Tools                                          |
| `Alt+7`  | Settings & API Keys                                |
| `Alt+O`  | Switch between Classic Dashboard and 3D Spatial OS |
| `Ctrl+K` | Open the quick command palette                     |

---

## 7. Operations Commands

```bash
# Check the state of the containers
docker compose -f infrastructure/docker/docker-compose.yml ps

# Follow the live logs
docker compose -f infrastructure/docker/docker-compose.yml logs -f

# Stop the infrastructure
docker compose -f infrastructure/docker/docker-compose.yml down

# Restart the stack
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

---

## 8. Note on Experimental Modules

The advanced research labs (_CareerLab, TradingLab, Domotique, OSINT_) are currently disabled in the main navigation so that this Beta focuses on the core foundation: multi-agent orchestration, MCP tools and the code development environment.
