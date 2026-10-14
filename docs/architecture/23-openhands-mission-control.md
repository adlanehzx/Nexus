# 23 — OpenHands Mission Control

## Décision

NEXUS conserve OpenHands Mission Control comme service local durable distinct.
Il ne réimplémente ni ACP, ni les leases SQLite, ni le ledger paper-only.

```text
client web/mobile/desktop
          │ JWT NEXUS
          ▼
      NEXUS API ── contrat typé ──▶ Mission Control :18100
          │                              │
          │                              ├─ Antigravity ACP
          │                              ├─ Claude ACP
          │                              ├─ Codex ACP
          │                              └─ ledger paper-only
          ▼
dashboard administrateur
```

Cette séparation évite deux autorités concurrentes :

- NEXUS authentifie les utilisateurs et contrôle la surface publique ;
- Mission Control possède l'état des missions ACP et des simulations ;
- les clients ne joignent jamais directement le port 18100 ;
- le client `@nexus/mission-control-client` valide chaque réponse distante.

## Configuration

`MISSION_CONTROL_URL=http://127.0.0.1:18100` active l'intégration lorsque
l'API NEXUS tourne sur le même hôte. Une chaîne vide la désactive. HTTP est
refusé hors boucle locale ; une instance distante doit utiliser HTTPS.

Le statut apparaît dans le tableau de bord sous « Mission Control ». Les
mutations paper-only vivent sous `/api/v1/mission-control/*` et exigent un
compte administrateur NEXUS.

## Surface exposée

- santé, profils ACP et vérification du journal d'audit ;
- création et lecture de comptes fictifs EUR ;
- création et lecture de marchés fictifs ;
- ajout de cotations fictives ;
- soumission idempotente d'une recherche multi-agents ;
- lecture du résultat d'une recherche.

Il n'existe aucune route de trading réel, aucun wallet, aucune signature de
transaction et aucun proxy générique vers Mission Control.

## Limites de confiance

Le service distant est traité comme non fiable : timeout indépendant, schémas
Zod sur toutes les réponses, corps d'erreur jamais propagé, et refus explicite
d'un compte qui annoncerait `live_trading != 0`.

Mission Control reste lié à la boucle locale. Si NEXUS est conteneurisé, il ne
faut pas élargir l'écoute de Mission Control à `0.0.0.0` pour le rendre
joignable. Utiliser un réseau privé authentifié ou exécuter l'API NEXUS sur le
même hôte.
