# NEXUS — Guide de Démarrage Bêta

Bienvenue dans la version Bêta de **NEXUS**, la station de travail et d'orchestration multi-agents autonome.

---

## 1. Prérequis Système

- **Système d'exploitation** : Linux (Ubuntu, Debian, Fedora, Arch) ou macOS / WSL2
- **Docker & Docker Compose** : Docker v24+ et Docker Compose v2+
- **Navigateur Web récent** : Chrome, Firefox, Safari ou Edge
- **Agents IA (Optionnel mais recommandé)** :
  - Outils CLI installés sur la machine hôte (`claude`, `codex`, ou `agy`)
  - **OU** une clé API Cloud (Anthropic, OpenAI, Gemini, Mistral, OpenRouter)
  - **OU** les modèles Cloud gratuits intégrés (NVIDIA NIM / Llama 3)

---

## 2. Démarrage en Une Commande

Depuis la racine du dépôt :

```bash
bash scripts/quickstart.sh
```

Ce script effectue automatiquement :
1. La vérification de Docker et Docker Compose.
2. La détection des binaires CLI installés localement (`claude`, `codex`, `agy`).
3. La génération des clés cryptographiques Ed25519 et du coffre sécurisé (`MASTER_KEY`).
4. Le démarrage de la pile de conteneurs (`nexus-api`, `nexus-web`, `postgres`, `redis`, etc.).
5. La validation de la sonde de santé sur `http://127.0.0.1:8080/healthz`.

---

## 3. Accès au Dashboard

Une fois le démarrage confirmé :

| Mode d'accès | URL | Description |
| :--- | :--- | :--- |
| **Local** | [http://localhost:8080](http://localhost:8080) | Accès direct depuis votre machine |
| **Réseau / Tailscale** | `http://<VOTRE_IP_TAILSCALE>:8080` | Accès distant sécurisé (ex. mobile / PC portable) |
| **API Backend** | [http://localhost:8080/api/v1](http://localhost:8080/api/v1) | Endpoints REST & OpenAPI |

---

## 4. Assistant de Premier Lancement (Setup Wizard)

Lors de votre première visite, vous serez guidé par l'assistant interactif en 5 étapes :

1. **Compte Administrateur Local** : Définissez votre adresse email et un mot de passe sécurisé. Vos identifiants restent strictement stockés sur votre serveur local.
2. **Infrastructure & Données** : Initialisation sécurisée de la base de données PostgreSQL et du cache Redis.
3. **Connexion des Agents IA** :
   - **Détection CLI locale** : Si vous utilisez déjà `claude code`, `codex` ou `antigravity`, NEXUS détecte vos profils sans jamais demander vos mots de passe.
   - **Alternative Cloud** : Si aucune CLI n'est installée, cliquez simplement sur *"Continuer avec les LLMs Cloud"* pour utiliser les modèles intégrés ou configurer vos clés API.
4. **Capacités Optionnelles** : Automatisation de navigateur headless (CDP) et serveurs MCP.
5. **Validation & Smoke Test** : Test en direct de la chaîne d'orchestration avant d'accéder au tableau de bord.

---

## 5. Fonctionnalités Principales Disponibles en Bêta

- **NEXUS Chat Orchestré** : Assistant conversationnel multi-agents avec streaming direct, suggestions guidées et routage intelligent des tâches.
- **Gestion des Worktrees & Checkpoints VCS** : Créez, inspectez, fusionnez (*handoff*) vos worktrees Git et effectuez des rollbacks de points de contrôle sans blocage navigateur.
- **Moteur de Missions & Tâches** : Suivi des tâches en cours, annulation sécurisée et planification automatisée (Cron).
- **Gestion des Profils d'Agents** : Visualisation, configuration et test direct des adaptateurs ACP.
- **Catalogue MCP** : Connexion et gestion centralisée des serveurs d'outils Model Context Protocol.
- **Double Vue** : Dashboard Classique par défaut pour une productivité maximale, avec basculement fluide vers l'OS Spatial 3D immersif (`Alt+O`).

---

## 6. Raccourcis Clavier Principaux

| Raccourci | Action |
| :--- | :--- |
| `Alt+1` | Ouvrir le Chat Orchestré |
| `Alt+2` | Vue d'ensemble (Supervision) |
| `Alt+3` | Suivi des Tâches |
| `Alt+4` | Moteur de Mission |
| `Alt+5` | Gestion des Agents |
| `Alt+6` | Outils MCP |
| `Alt+7` | Paramètres & Clés API |
| `Alt+O` | Basculer entre Dashboard Classique et OS Spatial 3D |
| `Ctrl+K` | Ouvrir la Palette de commandes rapides |

---

## 7. Commandes d'Exploitation

```bash
# Vérifier l'état des conteneurs
docker compose -f infrastructure/docker/docker-compose.yml ps

# Consulter les journaux en direct
docker compose -f infrastructure/docker/docker-compose.yml logs -f

# Arrêter l'infrastructure
docker compose -f infrastructure/docker/docker-compose.yml down

# Redémarrer la pile
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

---

## 8. Remarque sur les Modules Expérimentaux

Les laboratoires de recherche avancée (*CareerLab, TradingLab, Domotique, OSINT*) sont actuellement désactivés de la navigation principale afin de concentrer cette version Bêta sur le socle central : orchestration multi-agents, outils MCP et environnement de développement de code.
