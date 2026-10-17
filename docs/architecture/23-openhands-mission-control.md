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
chat NEXUS + supervision administrateur
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

## Conversation NEXUS unique

Le dashboard ouvre désormais sur une seule façade de conversation. Un message
adressé à NEXUS suit ce chemin :

```text
message utilisateur
  → planificateur LLM remplaçable (DAG validé, plan conservateur de secours)
  → POST /v1/missions dans Mission Control
  → agents ACP exécutés en parallèle selon les dépendances
  → résultats amont injectés automatiquement dans les instructions aval
  → tâche nexus_final_synthesis
  → une réponse unique dans le chat
```

La route publique `POST /api/v1/orchestrator/messages` exige une session NEXUS.
Le client n'accède jamais directement au port 18100. L'identifiant externe de
chaque mission contient une empreinte irréversible du propriétaire ; la lecture
refuse donc un utilisateur différent, même s'il connaît l'UUID. L'URL du chat
conserve uniquement l'UUID de la mission active afin qu'un rechargement reprenne
le suivi, sans stocker de jeton ou de contenu sensible dans le navigateur.

Le planificateur choisit exclusivement parmi les profils annoncés par la sonde
de santé. Il peut être remplacé sans changer le moteur. En cas de sortie invalide
ou d'indisponibilité, un plan déterministe prend le relais. Mission Control reste
responsable de la persistance, des leases, des délais et des nouvelles tentatives.

Chaque tâche conserve désormais une liste ordonnée de profils de secours. Une
erreur ACP est classée à partir de la classification structurée d’OpenHands
(`auth`, `quota`, `rate_limit`, etc.) sans recopier le détail fournisseur. Le
profil est placé dans l’état correspondant et la tentative suivante bascule sur
le premier profil de secours disponible. Les résultats amont sont compactés de
façon déterministe avant injection selon le budget de contexte de la tâche.

Le registre conserve les pourcentages 5 h et hebdomadaires ainsi que les dates
de réinitialisation lorsqu’une source autorisée les fournit. Pour les
abonnements personnels qui n’exposent pas d’API de quota stable, ces valeurs
restent explicitement `null` : NEXUS s’appuie alors sur les erreurs structurées,
les cooldowns et les échecs observés, sans inventer un pourcentage.

## Registre d’agents

La page « Agents », réservée à l’administrateur, présente les profils réellement
enregistrés dans Mission Control : disponibilité, tâches actives, file d’attente
et dernier état observé. Elle découvre aussi les profils existants dans
OpenHands via sa projection sans secrets `/api/agent-profiles`.

L’ajout ne transmet jamais l’authentification ACP au navigateur. L’utilisateur
sélectionne un profil OpenHands existant et lui attribue une clé NEXUS. Mission
Control vérifie l’existence du profil, sauvegarde le fichier de registre sous
`profiles.production.json.bak-<UTC>`, remplace la configuration atomiquement,
puis synchronise son registre SQLite à chaud. Les missions en cours ne sont pas
interrompues.

La même page peut aussi créer directement un profil ACP en clonant un adaptateur
local déjà approuvé (Antigravity, Claude ou Codex), avec un nom et éventuellement
un modèle différents. Cette opération passe par la clé de service conservée côté
Mission Control : la clé OpenHands n’est jamais renvoyée au navigateur. Le profil
créé est immédiatement ajouté au registre NEXUS. Un fournisseur entièrement
nouveau exige toujours l’installation préalable de son adaptateur ACP local ; il
peut ensuite être importé depuis la même page.

## Surface exposée

- santé, profils ACP et vérification du journal d'audit ;
- création et lecture de comptes fictifs EUR ;
- création et lecture de marchés fictifs ;
- ajout de cotations fictives ;
- soumission idempotente d'une recherche multi-agents ;
- lecture du résultat d'une recherche.
- soumission et suivi d'un DAG ACP générique depuis la conversation NEXUS.

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
