# 16 — Agent Core (implémenté)

Ce document décrit le moteur **tel qu'il est construit**, par opposition au
document [03 — Architecture de l'agent](03-agent.md), qui en pose la conception.
En cas de divergence, celui-ci fait foi pour le code existant.

Paquets concernés : [`@nexus/agent-core`](../../packages/agent-core),
[`@nexus/tools`](../../packages/tools), [`@nexus/llm`](../../packages/llm),
[`@nexus/memory`](../../packages/memory).

## 1. Découpage réel

Le cahier des charges nommait onze pièces. Elles existent, réparties selon les
plans de l'architecture ([00 §4](00-overview.md)) — le plan de capacité ne
connaît pas le LLM, le plan de raisonnement ne connaît pas les implémentations
d'outils :

| Pièce demandée        | Où elle vit                         | Plan         |
| --------------------- | ----------------------------------- | ------------ |
| `AgentOrchestrator`   | `agent-core/src/orchestrator.ts`    | raisonnement |
| `AgentLoop`           | `agent-core/src/loop.ts`            | raisonnement |
| `AgentContext`        | `agent-core/src/context.ts`         | raisonnement |
| `AgentState`          | `agent-core/src/state.ts`           | raisonnement |
| `Planner`             | `agent-core/src/planner.ts`         | raisonnement |
| `ExecutionPolicy`     | `agent-core/src/policy.ts`          | gouvernance  |
| `ToolRegistry`        | `tools/src/registry.ts`             | capacité     |
| `ToolExecutor`        | `tools/src/executor.ts`             | capacité     |
| `PermissionService`   | `tools/src/permission-service.ts`   | gouvernance  |
| `ConfirmationService` | `tools/src/confirmation-service.ts` | gouvernance  |
| `ToolDefinition`      | `tools/src/definition.ts`           | capacité     |

`agent-core` ne dépend ni de `@nexus/database`, ni de MCP, ni d'un SDK de
fournisseur. Il reçoit des ports : `LLMProvider`, `MemoryProvider`,
`AgentRunStore`. C'est ce qui le rend testable sans PostgreSQL ni réseau.

## 2. Échelle de risque — cinq niveaux

L'architecture initiale en proposait trois (`SAFE` / `CONFIRM` / `CRITICAL`).
L'implémentation en retient **cinq** : `SAFE < LOW < MEDIUM < HIGH < CRITICAL`.

Le gain n'est pas cosmétique. Avec trois niveaux, « écrire une note dans mon
espace de travail » et « envoyer un email à un tiers » tombaient dans le même
seau et déclenchaient la même carte de confirmation — la voie royale vers la
fatigue de confirmation ([R3](../RISKS.md)). Cinq niveaux permettent un **seuil
d'auto-approbation** (`autoApproveMaxRisk`, `LOW` par défaut) qui sépare les deux.

La règle d'escalade est inchangée et reste vérifiée par les tests : le risque
peut monter, jamais descendre. Un outil `CRITICAL` exige une confirmation même
s'il déclare `requiresConfirmation: false` — un outil ne peut pas s'auto-dispenser
d'un accord sur une action irréversible.

Le tableau de correspondance est dans [09 §3](09-security-permissions.md).

## 3. Un appel d'outil ne vient que d'un bloc structuré

`Planner.decide()` lit les blocs `tool_call` renvoyés par le fournisseur. Aucune
expression régulière, aucune analyse de texte, nulle part. Les schémas d'entrée
sont dérivés des schémas Zod par `z.toJSONSchema` et transmis au fournisseur ;
les arguments reviennent déjà désérialisés.

Conséquence testée : un agent ne peut pas exécuter une action « hallucinée dans
la prose ». Si le modèle décrit une action en texte sans émettre de bloc, la
boucle la traite comme une réponse finale — elle n'invente rien.

## 4. Suspension et reprise

`waiting_for_confirmation` est un état persisté, pas un drapeau en mémoire.

```
run() ─▶ … ─▶ PermissionService: CONFIRM
              ConfirmationService.request()  → payloadHash, nonce d'expiration
              state.pendingConfirmation = { confirmationId, call, remainingCalls }
              state.suspendedAt = now
              store.save(state)              → le worker est LIBÉRÉ
                     ⋮  (minutes)
resume(runId, "approved")
              deadlineAt += now - suspendedAt        ← le temps humain est rendu
              confirmations.resolve()                 → expirée ? déjà tranchée ?
              matchesPayload(call.arguments)          → sinon REFUS
              executeApproved() puis la boucle reprend
```

Quatre garanties, chacune couverte par un test :

1. **Le worker ne bloque jamais** sur un humain.
2. **`payloadHash`** lie l'accord aux arguments exacts. Un caractère modifié
   après coup annule l'autorisation.
3. **Une demande expirée n'est jamais auto-approuvée**, et une demande déjà
   tranchée ne peut pas l'être deux fois.
4. **Un refus abandonne les appels frères** du même tour : si l'utilisateur
   refuse une action d'un lot, exécuter les suivantes est présomptueux.

## 5. Ce qui arrête la boucle

Rien d'autre que ceci :

| Cause                                      | Statut       | `stopReason`                                           |
| ------------------------------------------ | ------------ | ------------------------------------------------------ |
| Réponse finale du modèle                   | `completed`  | `final_answer`                                         |
| Budget d'itérations, d'outils, ou de temps | `incomplete` | `max_iterations` · `max_tool_calls` · `global_timeout` |
| N échecs d'outil consécutifs               | `incomplete` | `tool_failure_limit`                                   |
| Confirmation refusée ou expirée            | `incomplete` | `confirmation_rejected` · `confirmation_expired`       |
| Annulation utilisateur                     | `cancelled`  | `cancelled`                                            |
| Panne du fournisseur                       | `failed`     | `provider_error`                                       |

Tout le reste — outil inconnu, arguments invalides, permission refusée, échec
d'exécution, sortie non conforme, boucle détectée — **redevient une observation**
réinjectée au modèle. C'est la différence entre un agent qui explique et un agent
qui plante.

Sur un budget épuisé, `#partialSummary()` construit une synthèse déterministe :
la raison de l'arrêt, ce qui a réussi, ce qui a échoué, et le dernier apport du
modèle. Un agent qui s'arrête sans rien dire est un défaut produit.

## 6. Fiabilité de l'exécution

- **Délai imposé, pas demandé.** `ToolExecutor` fait courir l'exécution contre le
  signal (`Promise.race`) : un outil qui ignore son `AbortSignal` est quand même
  interrompu. Testé avec un outil qui ne se termine jamais.
- **Annulation et délai sont distingués.** Les deux signaux sont combinés mais
  conservés séparément ; l'intention de l'utilisateur prime sur le délai.
- **Reprise ciblée.** Seules les erreurs déclarées `retryable` sont réessayées.
  Une erreur brute d'outil ne l'est **pas** : réessayer par défaut enverrait deux
  fois le même email. Un outil signale un échec transitoire par
  `RetryableToolError`.
- **Un outil non idempotent n'est jamais rejoué.** On ne peut pas savoir si la
  première tentative a déjà produit son effet.
- **Backoff exponentiel plafonné, jitter dans la moitié haute** — il désynchronise
  les clients sans effacer la croissance.

## 7. Secrets

`redact()` s'applique avant qu'une valeur n'entre dans la trace ou dans un
événement. Deux niveaux, parce qu'un seul ne suffit pas :

- par **nom de clé** : `password`, `token`, `apiKey`, `authorization`,
  `client_secret`, `private_key`… ;
- par **forme de valeur** : `sk-…`, `ghp_…`, JWT, `Bearer …`, bloc PEM.

Le second existe parce qu'un secret finit toujours par se retrouver dans un champ
innocemment nommé `value`. Un test vérifie qu'un mot de passe passé en argument
d'outil n'apparaît ni dans `AgentRunRecord`, ni dans les événements.

## 8. Écarts assumés par rapport au document 03

| Point                  | Document 03                | Implémentation                                | Pourquoi                                                                                            |
| ---------------------- | -------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Niveaux de risque      | 3                          | 5                                             | Seuil d'auto-approbation, cf. §2                                                                    |
| Persistance            | Prisma dès la boucle       | Port + implémentation mémoire                 | `agent-core` ne doit pas dépendre de `db` (ADR-003)                                                 |
| Planner planifié       | Mode `PLANNED` avec `Task` | Mode réactif seul                             | Le mode planifié arrive avec les tâches (phase 6) ; la boucle réactive couvre les cas de la phase 2 |
| Streaming              | Tokens vers le WebSocket   | `stream()` implémenté, boucle en `generate()` | Le branchement WS est en phase 1                                                                    |
| Compaction             | Dans la boucle             | Absente                                       | Phase 6 ; le point d'insertion est identifié (`ContextAssembler`)                                   |
| `execute()` d'un outil | Renvoie `ToolResult`       | Renvoie la sortie ou **lève**                 | Un auteur d'outil écrit du code normal ; l'exécuteur construit le résultat                          |

## 9. Tests

124 tests dans le monorepo, dont 43 pour `agent-core` et 37 pour `tools`.

Seule frontière remplacée : le modèle (`ScriptedLLMProvider`), plus l'horloge de
backoff — enregistrée, jamais attendue, ce qui rend le calcul du backoff
assertable exactement. Registre, permissions, confirmations, exécuteur, boucle et
magasin d'états s'exécutent réellement, avec de vrais outils qui réussissent,
échouent, dépassent leur délai ou ignorent leur signal.

Le détail des scénarios couverts est dans le
[README du paquet](../../packages/agent-core/README.md).
