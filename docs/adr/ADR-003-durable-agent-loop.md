# ADR-003 — Boucle agentique durable, exécutée dans un worker séparé

**Statut** : Proposé · 2026-09-01 · **Décision la plus structurante du projet**

## Contexte

Trois exigences du cahier des charges sont incompatibles avec une boucle agentique classique
tenue en mémoire dans le processus HTTP :

1. **Confirmation humaine** — un run peut attendre plusieurs minutes une réponse de l'utilisateur.
2. **Annulation** — depuis un autre appareil que celui qui a lancé le run.
3. **Robustesse** — un redéploiement ou un crash ne doit pas perdre un run en cours, surtout
   s'il a déjà envoyé un email ou modifié un fichier.

## Décision

1. La boucle est un **réducteur sur un état persisté** : `AgentRun` porte l'état, `AgentStep`
   journalise chaque transition (`UNIQUE(runId, index)`).
2. Elle s'exécute dans `apps/worker` (BullMQ), séparé de `apps/api`.
3. Une confirmation **suspend** le run (`WAITING_CONFIRMATION`) et **libère** le worker ; la
   réponse de l'utilisateur enfile un job de reprise qui recharge l'état.
4. Un verrou Redis par run garantit qu'un seul worker le fait avancer.
5. La fonction de transition est pure et injectée de ports (`llm`, `store`, `executor`, `clock`) :
   testable sans base ni réseau, et **rejouable**.

## Alternatives

- **Boucle en mémoire dans l'API.** Simple, mais : un déploiement tue les runs, une confirmation
  bloque une connexion HTTP, l'annulation cross-device exige un canal ad hoc, et rien n'est
  rejouable. Écarté.
- **Moteur de workflow durable (Temporal, Inngest, Restate).** Techniquement la meilleure réponse
  au problème — mais Temporal ajoute un cluster à opérer sur un VPS, et Inngest/Restate ajoutent
  une dépendance SaaS ou un service de plus. Notre besoin durable se réduit à « persister des
  steps et reprendre » : BullMQ + Postgres le couvrent. **Chemin de migration conservé** : la
  boucle étant déjà une machine à états explicite, la porter sur un moteur de workflow serait
  une réécriture de l'exécuteur, pas de la logique.
- **Sous-processus par run.** Isolation mémoire réelle, mais coût de démarrage et complexité de
  supervision disproportionnés.

## Conséquences

**Positives** — les runs survivent aux déploiements et aux crashs ; le « Run Inspector » et les
évals découlent gratuitement des steps persistés ; l'API garde un p99 propre ; workers et API
scalent séparément.

**Négatives, acceptées** — plus de code que la version naïve ; chaque transition écrit en base
(coût mesuré : quelques écritures par itération, négligeable) ; il faut gérer explicitement le
verrou, l'idempotence de reprise et les runs orphelins (alerte « RUNNING > 10 min »).
