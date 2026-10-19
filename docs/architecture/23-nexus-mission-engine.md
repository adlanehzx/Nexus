# 23 — NEXUS Mission Engine

## Décision

NEXUS possède son propre service local durable. Le runtime ACP, les leases
SQLite et le ledger paper-only vivent tous dans le dépôt NEXUS.

```text
client web/mobile/desktop
          │ JWT NEXUS
          ▼
      NEXUS API ── contrat typé ──▶ NEXUS Mission Engine :18100
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
- NEXUS Mission Engine possède l'état des missions ACP et des simulations ;
- les clients ne joignent jamais directement le port 18100 ;
- le client `@nexus/mission-control-client` valide chaque réponse distante.

## Configuration

`MISSION_CONTROL_URL=http://127.0.0.1:18100` active l'intégration lorsque
l'API NEXUS tourne sur le même hôte. Une chaîne vide la désactive. HTTP est
refusé hors boucle locale ; une instance distante doit utiliser HTTPS.

Le statut apparaît dans le tableau de bord sous « Mission Engine ». Les
mutations paper-only vivent sous `/api/v1/mission-control/*` et exigent un
compte administrateur NEXUS.

Les réglages appliqués aux nouvelles missions sont conservés dans
`services/mission-engine/config/runtime-settings.json`. L'onglet
« Configuration » permet de modifier à chaud les délais, tentatives, délais de
reprise, budgets de contexte, revue qualité et ordres de priorité. Chaque
écriture est validée, atomique et précédée d'une copie `.bak-<UTC>`.

## Conversation NEXUS unique

Le dashboard ouvre désormais sur une seule façade de conversation. Un message
adressé à NEXUS suit ce chemin :

```text
message utilisateur
  → planificateur LLM remplaçable (DAG validé, plan conservateur de secours)
  → POST /v1/missions dans NEXUS Mission Engine
  → agents ACP exécutés en parallèle selon les dépendances
  → résultats amont injectés automatiquement dans les instructions aval
  → contrôle qualité structuré pour les missions multi-tâches
  → correction par un autre profil et revalidation si nécessaire (2 cycles max.)
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
ou d'indisponibilité, un plan déterministe prend le relais. Mission Engine reste
responsable de la persistance, des leases, des délais et des nouvelles tentatives.

Chaque tâche conserve désormais une liste ordonnée de profils de secours. Une
erreur ACP est classée localement par le runtime NEXUS
(`auth`, `quota`, `rate_limit`, etc.) sans recopier le détail fournisseur. Le
profil est placé dans l’état correspondant et la tentative suivante bascule sur
le premier profil de secours disponible. Les résultats amont sont compactés de
façon déterministe avant injection selon le budget de contexte de la tâche.

Le registre conserve les pourcentages 5 h et hebdomadaires ainsi que les dates
de réinitialisation lorsqu’une source autorisée les fournit. Pour les
abonnements personnels qui n’exposent pas d’API de quota stable, ces valeurs
restent explicitement `null` : NEXUS s’appuie alors sur les erreurs structurées,
les cooldowns et les échecs observés, sans inventer un pourcentage.

Pour une mission multi-tâches, NEXUS ajoute un contrôleur qualité qui doit
produire un verdict JSON strict. Un verdict `revise` étend atomiquement le DAG
persisté avec une tâche de correction, confiée de préférence à un autre profil,
puis une nouvelle revue. La synthèse finale reste bloquée jusqu'à cette revue.
Le nombre de corrections est borné à deux ; une réponse de contrôle malformée
n'étend jamais le graphe et la synthèse finale conserve la responsabilité de
signaler les réserves. Le redémarrage du service ne perd ni les nouvelles tâches
ni leurs dépendances.

## Registre d’agents

La page « Agents », réservée à l’administrateur, présente les profils réellement
enregistrés dans Mission Engine : disponibilité, tâches actives, file d’attente
et dernier état observé. Elle découvre les adaptateurs déclarés dans le registre
ACP natif de NEXUS.

L’ajout ne transmet jamais l’authentification ACP au navigateur. L’utilisateur
sélectionne un profil ACP existant et lui attribue une clé NEXUS. Mission Engine
vérifie l’existence du profil, sauvegarde le fichier de registre sous
`profiles.production.json.bak-<UTC>`, remplace la configuration atomiquement,
puis synchronise son registre SQLite à chaud. Les missions en cours ne sont pas
interrompues.

La même page peut aussi créer directement un profil ACP en clonant un adaptateur
local déjà approuvé (Antigravity, Claude ou Codex), avec un nom et éventuellement
un modèle différents. Aucun identifiant fournisseur n’est renvoyé au navigateur.
Le profil créé est immédiatement ajouté au registre NEXUS. Un fournisseur entièrement
nouveau exige toujours l’installation préalable de son adaptateur ACP local ; il
peut ensuite être importé depuis la même page.

Chaque profil peut être ouvert depuis le dashboard pour modifier son nom, son
modèle, sa commande, ses arguments, son prompt système, son effort de
raisonnement, ses options ACP annoncées par l'adaptateur et une liste explicite
de dossiers supplémentaires, puis exécuter un vrai message de test ACP.
La désactivation le retire des nouvelles missions sans supprimer sa définition
ni interrompre une mission en cours. Les permissions restent limitées au
workspace et ne sont pas désactivables depuis l'interface. Les sessions et
identifiants des fournisseurs restent dans leurs CLI locales ; aucun token
n'est stocké ou affiché par le dashboard.

## Administration depuis le dashboard

La supervision et les actions administratives utilisent la même session NEXUS,
mais toutes les mutations continuent de passer par leurs routes métier et leurs
contrôles serveur :

- approbation, permissions et révocation des appareils ;
- annulation explicite d'une tâche active ;
- création et oubli de souvenirs ;
- lecture des notifications ;
- création de portefeuilles et marchés de simulation ;
- configuration, test et désactivation des agents ACP ;
- réglages persistants de l'orchestrateur ;
- coffre local de références secrètes, serveurs MCP ajoutés à chaud et
  configuration du worker Browser Use.

Les vues d'historique — runs, sécurité et journaux — restent naturellement des
vues de consultation. Les opérations irréversibles demandent une confirmation
dans l'interface. MCP est raccordé au `ToolRegistry` de l'API et se reconnecte à
chaud. Browser Use instancie le vrai client HTTP seulement quand sa configuration
est activée et que son jeton existe dans le trousseau Linux. Les fichiers
`services/api/config/*.json` ne contiennent que des références
`vault://nexus/...`, jamais les valeurs.

### Supervision unifiée et persistance

Mission Engine expose une liste filtrable des missions durables. Chaque
projection contient le DAG, les dépendances et les tentatives ACP, mais jamais
le transcript interne ni les blocs de raisonnement du fournisseur. L'API NEXUS
filtre cette liste avec le préfixe propriétaire dérivé du compte avant de la
présenter dans trois vues complémentaires :

- `Tâches` montre une mission comme un plan et ses tâches ACP comme étapes ;
- `Runs agent` montre chaque tentative ACP, son profil, sa durée et son erreur ;
- `Outils` déclare chaque profil actif sous la forme `acp.<profil>`, à côté des
  outils natifs et navigateur.

La page `Missions ACP` conserve la chronologie complète mission → tâches →
tentatives. SQLite reste la source de vérité de l'orchestration : PostgreSQL ne
duplique pas cet état.

Les préférences et souvenirs PostgreSQL sont assemblés avant la planification,
puis injectés dans les tâches et la synthèse finale dans un bloc explicitement
traité comme données non fiables. Une phrase mémorisée ne peut donc pas devenir
une instruction de niveau système.

Les conversations, leurs messages, les notifications et les états de runs Agent
Core sont persistés dans PostgreSQL. Agent Core est exécutable par les routes
`/api/v1/agent-core/runs` ; ses reprises après confirmation passent par la même
politique de permissions que les outils natifs. Les journaux applicatifs et de sécurité sont conservés dans
`var/observability` sous forme JSONL rédigée, permissions `0600`, avec une
fenêtre bornée et remplacement atomique. Ils survivent au redémarrage sans
conserver de token brut.

Les quotas 5 h et hebdomadaires restent `null` tant que le fournisseur ne les
expose pas officiellement. NEXUS ne déduit pas un faux pourcentage à partir du
nombre de requêtes ; le fallback continue de s'appuyer sur les erreurs ACP
structurées et les cooldowns observés.

## Surface exposée

- santé, profils ACP et vérification du journal d'audit ;
- création et lecture de comptes fictifs EUR ;
- création et lecture de marchés fictifs ;
- ajout de cotations fictives ;
- soumission idempotente d'une recherche multi-agents ;
- lecture du résultat d'une recherche.
- soumission et suivi d'un DAG ACP générique depuis la conversation NEXUS.

Il n'existe aucune route de trading réel, aucun wallet, aucune signature de
transaction et aucun proxy générique vers Mission Engine.

## Limites de confiance

Le service distant est traité comme non fiable : timeout indépendant, schémas
Zod sur toutes les réponses, corps d'erreur jamais propagé, et refus explicite
d'un compte qui annoncerait `live_trading != 0`.

Mission Engine reste lié à la boucle locale. Si NEXUS est conteneurisé, il ne
faut pas élargir son écoute à `0.0.0.0` pour le rendre
joignable. Utiliser un réseau privé authentifié ou exécuter l'API NEXUS sur le
même hôte.
