# Architecture NEXUS — 26. Gestion Multi-Comptes Fournisseurs

## 1. Contexte & Objectifs

NEXUS s'appuie sur des agents CLI locaux connectés aux abonnements existants de l'utilisateur (ChatGPT Plus pour Codex, Claude Pro pour Claude Code, Google AI Pro pour Antigravity), sans recourir à des clés API payantes tierces.

Pour répondre aux cas d'usage avancés et aux contraintes de quotas observés, NEXUS permet d'administrer **plusieurs comptes et identités par fournisseur** :

- `antigravity-personnel` / `antigravity-secondaire` ;
- `claude-principal` / `claude-backup` ;
- `codex-principal` / `codex-dev`.

Chaque identité dispose :

1. De son **profil système** et de sa **session CLI étanche** ;
2. De son **état d'authentification** surveillé ;
3. De ses **quotas observés** (fenêtres 5h, hebdo, état d'épuisement) ;
4. De ses **cooldowns** (temps de recharge automatiques et manuels) ;
5. De sa **priorité** d'arbitrage (1 = haute priorité) ;
6. De son **historique de fiabilité** et score de succès (0.00 à 1.00).

---

## 2. Isolation Étanche des Sessions CLI

Les outils CLI (Claude Code, Antigravity `agy`, Codex CLI) stockent par défaut leurs jetons de session et caches dans le dossier utilisateur (`~/.claude`, `~/.config/agy`, etc.).

Pour garantir une séparation stricte sans collision entre identités d'un même fournisseur :

- Chaque identité se voit assigner un répertoire de session dédié :
  ```
  ~/.nexus/agents/sessions/<account-id>/
  ```
- Ce répertoire est créé avec des droits restreints (`0700`, accessible uniquement par l'utilisateur hôte).
- Lors de l'invocation ACP (`@nexus/agent`), les variables d'environnement appropriées sont injectées dans le sous-processus :
  - `CLAUDE_CONFIG_DIR` pour Claude Code ;
  - `ANTIGRAVITY_CONFIG_DIR` / `GEMINI_CLI_HOME` pour Antigravity ;
  - `CODEX_CONFIG_DIR` pour Codex ;
  - `XDG_CONFIG_HOME` comme repli standard.
- Les identifiants de session et trousseaux ne sont **jamais partagés** entre deux comptes.

---

## 3. Modèle de Données & États

Chaque compte fournisseur est représenté selon le schéma typé Zod :

```typescript
export interface ProviderAccount {
  id: string; // ex: "claude-backup", slug [a-z0-9_-]
  provider: "claude" | "antigravity" | "codex" | string;
  name: string; // Nom convivial
  profileKey: string; // Profil ACP associé
  sessionDir: string; // Chemin absolu du profil CLI isolé
  env: Record<string, string>; // Variables d'environnement spécifiques
  authStatus: "authenticated" | "unauthenticated" | "expired" | "unknown";
  lastCheckedAt: string | null;
  quotas: {
    remaining5hPercent: number | null;
    remainingWeekPercent: number | null;
    resets5hAt: string | null;
    resetsWeekAt: string | null;
    exhausted: boolean;
  };
  cooldown: {
    active: boolean;
    until: string | null; // Date ISO d'expiration
    reason: string | null;
  };
  priority: number; // 1 = priorité maximale
  reliability: {
    score: number; // 0.00 à 1.00
    totalRuns: number;
    successCount: number;
    failureCount: number;
    consecutiveFailures: number;
    lastErrorCategory: string | null;
    lastErrorAt: string | null;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

---

## 4. Politique de Cooldowns et Fiabilité

### 4.1 Cooldown Automatique

Lorsqu'un run agent échoue, la catégorie de l'erreur détermine l'action préventive :

- **`rate_limited`** (code 429 ou rate limit CLI) :
  - Cooldown automatique de **60 secondes**.
  - Raison : _« Rate limit détecté par le CLI »_.
- **`quota_exhausted`** (quota 5h ou message de limite atteint) :
  - `quotas.exhausted = true`.
  - Cooldown automatique de **300 secondes** (5 minutes) ou jusqu'à la réinitialisation observée.
  - L'identité est exclue de l'arbitrage automatique en faveur d'un compte secondaire.
- **`auth_required`** (session expirée ou révocation) :
  - `authStatus = "expired"`.
  - Cooldown automatique de **600 secondes** (10 minutes) pour éviter le martèlement d'échecs.

### 4.2 Score de Fiabilité

Le score de fiabilité est calculé dynamiquement :
$$\text{Score} = \frac{\text{successCount}}{\text{totalRuns}}$$

Les identités avec des échecs consécutifs sont rétrogradées lors de la sélection, incitant l'orchestrateur à router les missions critiques vers les comptes les plus stables.

---

## 5. Algorithme de Sélection Intelligente (`selectAccount`)

Pour un fournisseur donné (`claude`, `antigravity`, ou `codex`) :

1. **Filtrage des candidats viables** :
   - Cooldown inactif (`cooldown.active === false` ou date expirée) ;
   - Quota non épuisé (`quotas.exhausted === false`) ;
   - Authentification valide (`authStatus !== "expired"` et `authStatus !== "unauthenticated"`).
2. **Ordre de tri** :
   - **Priorité croissante** : `priority = 1` avant `priority = 2` ;
   - **Score de fiabilité décroissant** : `0.98` avant `0.85` ;
   - **Échecs consécutifs croissants** : `0` avant `1`.
3. **Repli ordonné** :
   - Si tous les comptes sont en cooldown ou épuisés, l'algorithme sélectionne le compte le plus proche de la sortie de cooldown pour minimiser l'attente globale.

---

## 6. Sécurité & Confidentialité

- **Aucun secret dans le dashboard ou l'API** : Les jetons de session, cookies et variables sensibles restent strictement cantonnés aux répertoires de session locaux (`~/.nexus/agents/sessions/<id>`) avec droits `0700`.
- **Contrôle d'accès** : Les routes `/api/v1/orchestrator/accounts/*` exigent le rôle administrateur (`requireAdmin`).
- **Persistance locale atomique** : Stockage dans `var/config/provider-accounts.json` via écriture atomique (écriture temporaire puis renommage). Aucun fichier de session n'est versionné dans Git.
