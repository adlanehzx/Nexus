# 06 — Devices & Device Agent

## 1. Le concept

Un **Device** est une machine enregistrée capable d'exécuter des tâches pour le compte de son
propriétaire : lire/écrire des fichiers, lancer une commande, inspecter Docker, ouvrir un projet.
Le **Device Agent** est le démon installé sur cette machine.

Inversion de flux importante : le serveur **n'ouvre jamais** de connexion vers le PC. C'est le PC
qui se connecte au serveur en WebSocket sortant. Aucun port à ouvrir, aucun NAT à traverser,
aucune IP fixe à connaître. Le serveur pousse ensuite des tâches dans ce canal.

```mermaid
sequenceDiagram
  participant DA as Device Agent (PC)
  participant API as API / WS Gateway
  participant WK as Agent Runtime
  DA->>API: WSS /ws/device + device JWT
  API->>DA: device.ready { capabilities, policyVersion }
  loop toutes les 20 s
    DA->>API: device.heartbeat { load, uptime, version }
  end
  WK->>API: dispatch task (Redis)
  API->>DA: device.task.assign { taskId, tool, args, idemKey, deadline }
  DA->>API: device.task.accepted
  DA-->>API: device.task.progress { stdout chunk, pct }
  DA->>API: device.task.result { ok, output, metrics }
  API->>WK: résultat (Redis)
```

## 2. Choix technique : Node headless + coquille Tauri

Le Device Agent est un **démon Node.js** distinct de l'application desktop
(→ [ADR-007](../adr/ADR-007-device-agent-node.md)) :

- il réutilise `@nexus/device-protocol` et `@nexus/contracts` — un seul protocole typé, jamais
  réimplémenté en Rust ;
- il tourne **sans interface**, en service Windows / launchd / systemd : l'agent doit pouvoir
  agir même si l'application desktop est fermée ;
- l'app Tauri l'installe, le supervise et l'expose dans l'UI (statut, logs, permissions), et peut
  le lancer en sidecar pour un usage simple.

Distribution : binaire unique via Node SEA (ou `pkg`), signé, avec auto-update vérifié par
signature.

## 3. Enregistrement & authentification

**Appairage** (une fois par machine) :

1. L'utilisateur ouvre Settings → Devices → « Ajouter un appareil » ; l'API émet un
   `pairingCode` à 8 caractères, TTL 5 min, à usage unique.
2. Le Device Agent l'envoie avec une **clef publique Ed25519** qu'il vient de générer ; la clef
   privée reste dans le keychain OS (DPAPI sur Windows, Keychain sur macOS, libsecret sur Linux).
3. Le serveur crée le `Device` et retourne un `deviceId` + un certificat d'appartenance.

**Connexion** (à chaque fois) : challenge-response. Le serveur envoie un nonce, l'agent le signe
avec sa clef privée. Aucun secret partagé de longue durée ne transite ; un token volé dans un log
ne suffit pas à se faire passer pour l'appareil. Un `Device` peut être révoqué instantanément
depuis l'app (la révocation coupe la connexion en cours, pas seulement les suivantes).

## 4. Politique de sécurité locale

Le Device Agent applique **sa propre politique**, indépendamment du serveur. C'est une défense en
profondeur : si le backend est compromis, le PC ne devient pas une machine ouverte.

```yaml
# ~/.nexus/device-policy.yaml — édité par l'humain, pas par l'agent
filesystem:
  allow: ["~/dev/**", "~/Documents/nexus/**"]
  deny: ["~/.ssh/**", "~/.aws/**", "**/.env*", "**/node_modules/**"]
  maxFileSizeMb: 20
shell:
  mode: allowlist # allowlist | confirm-all | disabled
  allow: ["git *", "pnpm *", "npm *", "docker ps", "docker logs *", "pytest *"]
  deny: ["rm -rf /*", "sudo *", "curl * | sh", "* > /dev/sd*", "format *"]
  workdirRoots: ["~/dev"]
  timeoutSec: 300
network: { egress: deny } # l'agent ne fait pas de requêtes sortantes lui-même
```

Chaque tâche entrante est validée contre cette politique **avant** exécution. Un refus local
remonte comme `ToolExecutionError(code=DEVICE_POLICY_DENIED)` et devient une observation pour
l'agent — qui peut alors expliquer à l'utilisateur ce qu'il faudrait autoriser.

Le `shell.exec` passe en plus par un **classifieur de commande** (parsing, pas regex naïve) qui
détecte : suppression récursive, redirection vers un périphérique, élévation de privilèges,
pipe vers un interpréteur, modification de credentials. Une commande classée dangereuse est
`CRITICAL` même si l'allowlist la couvre.

## 5. Fiabilité

| Aspect           | Mécanisme                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Heartbeat        | toutes les 20 s ; `lastSeenAt` en base ; offline après 60 s                                 |
| Reconnexion      | backoff exponentiel + jitter, plafonné à 30 s, illimité                                     |
| Reprise de tâche | à la reconnexion, l'agent renvoie l'état des tâches en cours (`taskId`)                     |
| Idempotence      | `idemKey` par tâche ; une tâche déjà exécutée renvoie son résultat mémorisé (TTL 1 h)       |
| Annulation       | `device.task.cancel` → SIGTERM puis SIGKILL après grâce ; `killTree` pour les enfants       |
| File locale      | max N tâches concurrentes ; au-delà, rejet explicite plutôt que file infinie                |
| Logs             | journal local rotatif + remontée structurée ; l'utilisateur peut tout inspecter             |
| Offline          | si aucun device en ligne, les outils `device.*` disparaissent du registre et l'agent le dit |

## 6. Ce que le Device Agent ne fait pas

- Il n'appelle jamais un LLM. Il n'a aucune intelligence, seulement des capacités.
- Il n'a aucun accès à la base de données ni aux secrets applicatifs.
- Il ne décide pas des permissions : il les **applique**, en second rideau derrière le serveur.
