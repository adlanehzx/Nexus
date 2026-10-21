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

Le worker applique **sa propre politique**, indépendamment du serveur. C'est
une défense en profondeur : si le cœur est compromis, le poste ne devient pas
une machine ouverte.

### Ce qui existait, et ce qui manquait

La politique existait — racines autorisées, exécutables autorisés, variables
d'environnement transmises, sous-commandes Docker, écriture Git — mais elle
vivait en **variables d'environnement**, avec trois coûts :

1. **Illisible.** `WORKER_ALLOWED_PATHS=C:\a,C:\b` n'est pas une politique
   qu'on relit avant de s'en remettre à elle.
2. **Pas de refus.** On ne pouvait qu'autoriser des racines. Interdire `~/.ssh`
   _sous_ une racine autorisée était impossible — alors que c'est le cas qui
   compte : on autorise son dossier de travail, et on veut en exclure trois
   endroits.
3. **Muette.** Une faute de frappe dans une liste séparée par des virgules
   élargit ou rétrécit silencieusement ce que NEXUS peut toucher.

### Le fichier

`~/.nexus/device-policy.yaml`, lu au démarrage du worker. Quand il existe, il
**remplace** les réglages d'environnement correspondants : il ne peut pas y
avoir deux sources de vérité sur ce qu'une machine autorise, et deviner
laquelle gagne est exactement le genre d'ambiguïté qui finit par ouvrir un
accès. Absent, rien ne change pour une installation existante.

```yaml
version: 1
filesystem:
  allow: [~/projets] # rien n'est accessible en dehors
  deny: # et les refus gagnent, même ici
    under: [~/.ssh, ~/.aws, ~/.gnupg]
    segments: [node_modules, .git]
    names: [.env*, id_rsa, credentials*]
  maxFileSizeMb: 20
exec:
  mode: allowlist # ou `disabled`
  allowedExecutables: [git, node, pnpm, python]
  allowedEnv: [PATH, HOME, LANG]
  timeoutSec: 300
git: { allowWrite: false }
docker: { allowedSubcommands: [ps, images, logs, inspect] }
network: { egress: deny }
```

### Trois décisions qui expliquent la forme

**Pas de liste blanche de commandes.** L'esquisse d'origine proposait
`shell: { allow: ["git *", "pnpm *"] }`. Elle n'est pas implémentée, et c'est
délibéré : le worker n'expose **nulle part** de fonction qui prenne une chaîne
de commande. Son API est structurée — un exécutable, un tableau d'arguments,
pas de shell — ce qui _supprime_ l'injection au lieu de la filtrer. Ajouter des
motifs de chaînes aurait eu l'air d'un durcissement tout en réintroduisant le
modèle plus faible.

**Pas de globs.** Les refus s'expriment en trois règles étroites — sous un
dossier, par segment, par nom avec au plus une étoile finale. Pour une liste de
refus, la taille de la surface de confiance _est_ le risque : un moteur de
motifs se comporte différemment selon l'échappement, la casse et les liens, et
une divergence subtile n'y est pas un défaut d'affichage mais un trou. Les
trois cas qui comptaient s'expriment sans lui.

**Pas de mode « demander ».** Une confirmation est une décision humaine, et
elle se prend sur la surface où la personne se trouve — pas sur une machine qui
n'a pas d'écran. Le worker décide _localement_ si une action est permise ; il ne
sait pas demander. `exec.mode: disabled` ne se contente d'ailleurs pas de vider
une liste : les capacités d'exécution ne sont **pas déclarées** au cœur, qui
apprend donc que cette machine ne sait pas exécuter au lieu de lui envoyer des
tâches refusées une par une — ce qui ressemblerait à une panne.

### Ce que la politique ne peut pas faire

Elle ne peut que **fermer davantage**. Les refus intégrés au worker — `~/.ssh`,
`.gnupg`, `id_rsa`, la ruche SAM, les dossiers d'identifiants Windows —
s'appliquent quelle que soit la politique, et même si quelqu'un autorise `C:\`
par mégarde. C'est ce qui permet de laisser ce fichier s'éditer sans crainte.

Les refus comparent **sans tenir compte de la casse**, et les autorisations la
respectent. L'asymétrie est voulue : un refus trop large coûte un message
d'erreur lisible, un refus qui manque coûte un secret.

### L'éditeur

```sh
nexus policy init                                  # écrit un exemple commenté, refuse d'écraser
nexus policy show                                  # la politique en vigueur, et sa source
nexus policy check --path ~/.ssh/id_ed25519        # ce qu'elle décide, et pourquoi
nexus policy check --exec curl
```

`check` est la commande qui compte : une politique qu'on ne peut pas interroger
se relit en espérant l'avoir comprise. Elle rend `2` sur un refus et `0` sur une
autorisation — un refus n'est pas une erreur de la commande, c'est la réponse à
la question posée, ce qui rend l'appel utilisable dans un script.

Aucune de ces commandes ne modifie une politique existante sans `--force`.
« Éditeur » ne veut pas dire « écrit par NEXUS » : ce fichier est le seul
endroit où la machine se protège **du cœur**, et une politique que l'agent
pourrait réécrire ne protégerait de rien.

Un fichier **présent mais invalide** arrête le démarrage du worker, et n'est
jamais remplacé par les valeurs par défaut : quelqu'un a écrit une politique, et
démarrer en l'ignorant appliquerait l'inverse de son intention sans le dire.

### Ce qui reste à faire

- **La taille maximale de fichier n'est pas encore appliquée.** Elle est lue,
  validée et affichée ; la capacité `filesystem.read` ne la consulte pas.
- **`network.egress` est déclaratif.** Le worker ne sort pas de lui-même
  aujourd'hui, mais rien ne l'en empêche techniquement.
- **Le worker Android n'utilise pas ce fichier.** Sa politique est d'une autre
  nature (automatisation d'interface), et `@nexus/worker-core` doit rester
  portable sur Hermes — ce qui interdit d'y importer la lecture de fichiers.

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
