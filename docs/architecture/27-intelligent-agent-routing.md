# Architecture NEXUS — 27. Routage Intelligent des Agents & Feedback Learning

## 1. Contexte & Objectifs

Jusqu'alors, NEXUS s'appuyait sur des listes de priorité statiques définies dans les paramètres de runtime (`research_priority`, `review_priority`, `synthesis_priority`) pour affecter les tâches ACP à un agent (`claude`, `antigravity`, `codex`).

Le système de **routage intelligent multi-critères** (Chantier 13 de la Priorité 2) remplace ces choix statiques par un moteur d'arbitrage dynamique combinant :

1. La **classification sémantique et lexicale de la tâche** (`code`, `research`, `review`, `browser`, `synthesis`, `general`) ;
2. La **détection stricte des capacités requises** (ex. navigateur réel via `browser-harness`) ;
3. L'**état de santé et de connexion de l'agent** (authentification active, absence de cooldown) ;
4. Le **quota restant** (fenêtre glissante 5h et hebdomadaire de l'abonnement fournisseur) ;
5. L'**historique de qualité et de réussite** par catégorie (boucle de feedback learning persistant) ;
6. La **longueur de contexte** et l'adéquation au budget de tokens ;
7. Le **calcul automatique de chaînes de fallback dynamiques** ordonnées par score décroissant.

---

## 2. Taxonomie & Classification des Tâches

Le classifieur analyse l'instruction de la tâche selon un système d'analyse lexicale pondérée et d'intention :

| Catégorie | Signaux lexicaux principaux | Agent de référence par défaut |
|---|---|---|
| `browser` | Mots-clés navigation, chromium, clics, formulaires, scrape web | `codex`, `claude` (agents équipés du harness local) |
| `code` | Fichiers source (.ts, .py, etc.), refactor, build, git, tests vitest | `codex` (92), `claude` (90), `antigravity` (85) |
| `research` | Analyse de codebase, architecture, documentation, exploration | `antigravity` (95), `claude` (90), `codex` (80) |
| `review` | Critique, audit, vérification de sécurité, détection d'erreurs | `claude` (95), `codex` (85), `antigravity` (80) |
| `synthesis` | Résumé exécutif, synthèse finale, conclusion, bilan | `claude` (95), `antigravity` (85), `codex` (80) |
| `general` | Tâches polyvalentes non spécialisées | `claude` (85), `antigravity` (85), `codex` (85) |

---

## 3. Algorithme de Scoring Multi-Critères

Pour chaque candidat disponible, le score global $S_{total} \in [0, 100]$ est calculé selon la formule pondérée :

$$S_{total} = w_1 S_{compat} + w_2 S_{auth} + w_3 S_{quota} + w_4 S_{health} + w_5 S_{quality} + w_6 S_{perf} + w_7 S_{context}$$

Avec les coefficients standardisés :
- $w_1 = 0.30$ : **Compatibilité de la tâche** (affinité de base modulée par le taux de succès appris dans cette catégorie) ;
- $w_2 = 0.20$ : **Authentification** ($100$ si session valide, $0$ si expirée ou requise) ;
- $w_3 = 0.15$ : **Disponibilité des quotas** (pourcentage de réserve 5h/hebdo, $0$ si épuisé) ;
- $w_4 = 0.15$ : **Santé & Cooldown** ($100$ nominal, $0$ si cooldown actif ou consécutifs d'échecs) ;
- $w_5 = 0.10$ : **Qualité observée** (taux de passage au contrôle qualité NEXUS `pass` vs `revise`) ;
- $w_6 = 0.05$ : **Performance de latence** (ajustement selon la durée moyenne de résolution) ;
- $w_7 = 0.05$ : **Capacité de contexte** (adéquation de la fenêtre de contexte au volume de caractères).

### Règle d'éligibilité stricte
Si un agent est en cooldown, si son quota est épuisé ou s'il n'est pas compatible avec le navigateur local alors que la tâche l'exige, il est marqué `isAvailable = false` et relégué après les agents disponibles, avec son motif d'exclusion affiché.

---

## 4. Boucle d'Apprentissage (Feedback Learning)

Les statistiques d'exécution sont persistées dans `~/.nexus/agents/routing/agent-routing-stats.json` :

```typescript
export interface AgentCategoryPerformance {
  runs: number;
  successes: number;
  failures: number;
  qualitySum: number;
  totalDurationMs: number;
}

export interface AgentPerformanceStats {
  key: string;
  categories: Record<TaskCategory, AgentCategoryPerformance>;
  consecutiveFailures: number;
  lastUsedAt: string | null;
  lastOutcome: "success" | "failure" | "revised" | null;
}
```

À chaque issue de tâche ACP dans le Mission Engine :
1. `recordOutcome(key, category, outcome, durationMs, qualityVerdict)` met à jour les compteurs atomiquement.
2. Si un agent subit plusieurs échecs consécutifs, un cooldown automatique temporaire est suggéré.
3. Le score de compatibilité $S_{compat}$ s'auto-ajuste de $\pm 15$ points selon l'historique empirique réel.

---

## 5. Intégration dans l'Orchestrateur & API

1. **Recommandation dans le DAG (`AcpOrchestrator`)** :
   - Lorsque le planificateur LLM conçoit le DAG, l'orchestrateur injecte les recommandations de routage dans le prompt système du planificateur.
   - Si le LLM échoue ou en mode fallback déterministe (`fallbackPlan`), `agentRouter.bestProfileFor` sélectionne directement le profil le plus performant pour chaque tâche.
2. **Chaînes de fallback dynamiques** :
   - Pour chaque tâche, `router.fallbackOrderFor(profile, profiles, instruction)` calcule l'ordre optimal de repli en cas d'erreur ou d'épuisement de quota en cours d'exécution.
3. **Endpoints REST exposés (`/api/v1/orchestrator/routing/*`)** :
   - `GET /orchestrator/routing/matrix` : expose la matrice d'affinité temps-réel avec scores, statut d'auth et historique.
   - `POST /orchestrator/routing/evaluate` : évalue en direct une instruction et retourne le classement explicité.
   - `POST /orchestrator/routing/reset` : réinitialise l'apprentissage empirique (réservé admin).
4. **Interface Dashboard (`Agents.tsx`)** :
   - Tableau matriciel des affinités par catégorie ;
   - Simulateur d'évaluation de routage interactif permettant de tester instantanément l'attribution d'un prompt quelconque ;
   - Action de réinitialisation sécurisée par confirmation.
