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

Le pont vers Agent Core ajoute `NEXUS_ENGINE_API_URL` (base de l'API NEXUS).
Absente, l'exécutant Agent Core n'est pas configuré et toute tâche `agent-core`
échoue en catégorie `config` — jamais par un repli silencieux sur un agent ACP.
La passerelle refuse une URL HTTP qui sortirait de la boucle locale : l'assertion
voyage dans un en-tête `Authorization`.

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

## Pont Mission Engine → Agent Core

Une tâche du DAG peut déléguer à Agent Core au lieu de lancer un agent ACP. Elle
le déclare par `agent_kind: "agent-core"`.

### Authentification des appels API → moteur

Le port 18100 n'était protégé que par la boucle locale. C'est une frontière
suffisante pour une installation personnelle sur une machine, et elle cesse de
l'être dès qu'il y a Docker, plusieurs machines, des workers distants ou une
exposition publique : tout processus local pouvait soumettre une mission,
enregistrer un agent, modifier la configuration ou placer un ordre fictif.

L'API signe désormais ses appels sortants avec un **jeton de service** —
quatrième surface, audience `nexus-mission-engine`, deux minutes de durée de
vie. Émis par appel, donc aucun registre à tenir : ce qui le borne est son
expiration. Le moteur **ne détient que la clé publique** : il vérifie, il
n'émet pas. Compromettre le moteur ne permet pas de forger un appel de l'API.

**Un middleware, pas une dépendance par route.** Il y a quatorze routes de
mutation aujourd'hui, et celle qu'on ajoutera demain doit être protégée sans
qu'on y pense — oublier un `Depends` ne produit aucune erreur, juste une route
ouverte découverte trop tard. Le middleware filtre par méthode : tout ce qui
n'est pas `GET`, `HEAD` ou `OPTIONS` exige une identité. Un test parcourt les
routes de l'application et vérifie qu'aucune n'y échappe.

La lecture reste libre. Ce qui compte ici est l'écriture, et la boucle locale
reste la première barrière.

**Activation.** La présence de `NEXUS_ENGINE_API_PUBLIC_KEY_FILE` (ou
`NEXUS_ENGINE_API_PUBLIC_KEY`) active la vérification. Absente, le moteur garde
sa posture précédente et **le démarrage l'annonce dans le journal** plutôt que
de laisser croire à une protection qui n'existe pas.

Ce n'est pas encore actif par défaut, et la raison est concrète : l'API génère
une clé de signature éphémère à chaque démarrage tant que `AUTH_SIGNING_KEY`
n'est pas défini. Sans clé persistante, il n'y a pas de clé publique à
provisionner. La procédure est dans `.env.example`, et l'unité systemd porte la
ligne à décommenter.

Le motif d'un refus va dans le journal du moteur, jamais dans la réponse :
savoir _pourquoi_ un jeton est refusé n'aide que celui qui en forge un.

### Identité propriétaire signée

Jusqu'ici la propriété d'une mission n'était portée que par un préfixe
d'`external_key` (`nexus-<sha256(userId)[:24]>-…`). Lisible, mais invérifiable :
le moteur ne pouvait pas distinguer un préfixe légitime d'un préfixe recopié.

L'API émet désormais, au moment où l'utilisateur confie la mission, une
**assertion Ed25519** portant `{sub, svc, mek, iat, exp, iss, aud, jti}` —
propriétaire, service autorisé, et clé externe de la mission. Elle est stockée
sur la mission (`missions.owner_user_id`, `missions.owner_assertion`) et rejouée
à chaque appel du pont.

Trois propriétés tiennent cette conception :

1. **Le moteur ne sait pas signer.** Il n'a pas la clé. Compromettre sa base
   SQLite ne permet pas de forger une assertion, et ne donne accès qu'aux
   missions qui y figurent, jusqu'à leur expiration (24 h par défaut).
2. **L'audience sépare les surfaces.** Un jeton d'accès utilisateur porte
   `nexus-api`, une assertion porte `nexus-mission-grant`. Aucun des deux ne
   peut tenir le rôle de l'autre, bien qu'ils soient signés par la même clé.
3. **La portée est vérifiée, pas seulement la signature.** `assertMissionScope`
   refuse une assertion valide présentée pour une autre mission — sans quoi une
   seule assertion piloterait tout le travail du compte.

L'assertion est retirée du plan avant le calcul de `content_hash` : elle n'entre
donc ni dans `definition_json`, ni dans l'empreinte d'idempotence. Resoumettre
le même plan avec une assertion renouvelée reste idempotent.

### Cycle de vie d'une assertion

Une assertion vit vingt-quatre heures. Trois choses manquaient autour de ça, et
chacune cassait un cas réel.

**Le registre.** `mission_grants` consigne toute assertion émise, et
`requireMissionGrant` le consulte à chaque requête. Une signature valide ne
suffit donc plus : il faut aussi que l'assertion soit connue, active et non
expirée. C'est ce qui rend une assertion volée **retirable avant son terme** —
avant, le `jti` l'identifiait sans que personne ne le lise, et elle ouvrait
vingt-quatre heures.

Le refus est par défaut : une assertion signée mais absente du registre est
rejetée. Une signature correcte et inconnue signifie soit une clé compromise,
soit un enregistrement perdu, et aucun des deux ne doit ouvrir.

**La rotation.** Une mission suspendue sur une confirmation humaine peut durer
plus longtemps que son assertion ; elle devenait alors irreprenable. L'API
renouvelle donc dans la réponse d'un appel déjà authentifié, quand il reste
moins de huit heures. Pas de second point d'entrée, pas de second identifiant à
protéger, et la rotation se produit tant que l'ancienne assertion est valide.

L'ancienne n'est pas retirée : elle expire d'elle-même. La retirer casserait
toute requête déjà en vol, pour un gain nul. Conséquence à connaître :
plusieurs assertions d'une même mission sont valides simultanément, et c'est
pourquoi le retrait porte sur la **mission** et non sur une assertion.

Le moteur écrit l'assertion reçue en une seule instruction, donc atomiquement :
un worker interrompu laisse soit l'ancienne, soit la nouvelle.

**Le retrait.** Quand une mission atteint un état terminal, le worker demande
le retrait de ses assertions puis oublie celle qu'il stockait. C'est une
auto-révocation : on présente l'assertion qu'on veut retirer, ce qui ne donne
aucun pouvoir supplémentaire — là où un point d'entrée capable de révoquer
_autrui_ en donnerait un.

Le retrait passe par le worker et non par la transaction qui conclut la mission :
y faire un appel réseau rendrait la clôture dépendante de la disponibilité de
l'API. Un échec réseau laisse l'assertion expirer naturellement, ce qui est le
comportement d'avant — une dégradation, pas une régression.

**La resoumission idempotente rafraîchit l'assertion stockée.** C'était un
défaut : `submit` rendait la mission existante sans remplacer `owner_assertion`,
donc une mission longue restait collée sur un jeton périmé. Le propriétaire, en
revanche, n'est jamais réécrit — l'accepter permettrait de s'approprier une
mission en resoumettant sa clé externe sous un autre compte.

Tout cela est éprouvé avec une **horloge injectée**, y compris une mission de
trois jours qui traverse plusieurs rotations.

### Surface du pont

`POST /api/v1/agent-core/mission-runs`, gardée par `requireMissionGrant` —
distincte de `/agent-core/runs`, qui reste réservée aux utilisateurs. Le moteur
n'y choisit ni le compte (il vient de la signature) ni la mission (il ne peut
travailler que dans la sienne).

La conversation est créée au premier essai, puis mémorisée sur la tâche
(`tasks.agent_core_conversation_id`) et renvoyée aux essais suivants : un retry
prolonge l'historique au lieu d'en ouvrir un second.

### Exécutant réservé

Agent Core se présente comme une ligne de `profiles` (`profile_key='agent-core'`,
`agent_kind='agent-core'`). Le routage, la santé, les bails et les tentatives
continuent donc de fonctionner sans rien connaître d'Agent Core. Ce profil est
exclu de toutes les listes qui décrivent les agents ACP — `/v1/profiles`,
`routable_profiles`, le registre du tableau de bord — et `sync_profiles` ne le
désactive pas, puisqu'il n'a pas d'entrée dans la configuration des agents.

Une tâche `agent-core` **ne peut pas déclarer de repli**. Basculer vers un agent
ACP lui ferait perdre ses outils, ses permissions et ses confirmations, et
réussirait en apparence.

### Unicité d'un run par tentative

Un run Agent Core dure facilement plus longtemps qu'un bail de trente secondes.
Quand le bail expire pendant l'appel, un second worker reprend la tâche et
redemande un run : deux exécutions pour un même travail, et une action faite
deux fois dès qu'un outil a un effet externe.

Le pont transmet donc `attemptId`, et l'API réserve
`(missionExternalKey, taskKey, attemptId)` dans `agent_core_run_claims`, sous
contrainte unique. Une seconde demande sur la même tentative rend le run déjà
réservé **sans rappeler le modèle**.

Trois choix qui portent la garantie :

- **C'est l'insertion qui tranche, pas une lecture.** Un `SELECT` suivi d'un
  `INSERT` laisse passer deux requêtes dans l'intervalle ; l'index unique, non.
  Vérifié par un test qui lance huit réservations concurrentes et constate
  qu'exactement une est accordée.
- **La granularité est la tentative, pas la tâche.** Deux workers qui se
  disputent la même tentative convergent, alors qu'un vrai réessai après échec
  — nouvelle tentative, nouvel identifiant — obtient bien un run neuf. Réserver
  par tâche bloquerait la tâche sur son premier résultat.
- **L'identifiant du run est choisi avant la réservation**, et imposé à
  l'orchestrateur. Réserver puis compléter en deux temps laisserait, en cas
  d'incident entre les deux, une réservation qui ne désigne aucun run.

Si une réservation existe mais que son run est introuvable — l'appelant
précédent est entre les deux appels — la route répond `409` plutôt que d'en
lancer un second. Le moteur réessaie plus tard, ce que sa machinerie de bails
sait déjà faire.

`attemptId` reste facultatif dans le contrat, pour ne pas casser un appelant
plus ancien. Son absence désactive la garantie, et le journal le dit au lieu de
laisser croire le contraire.

### Suspension durable sur confirmation

Quand un run délégué ouvre une confirmation humaine, la tâche n'échoue pas :
elle passe en `awaiting_confirmation`, garde son run (`tasks.agent_core_run_id`)
et rend son bail. L'attente est en base, donc elle survit à un redémarrage du
moteur comme le reste de l'état.

**C'est le moteur qui interroge ; rien ne le notifie.** Le choix est délibéré.
Une notification aurait demandé d'ouvrir, sur le port du moteur, un point
d'entrée capable de marquer une tâche réussie avec un contenu arbitraire — sur
un port que tout processus local atteint, et qui n'est aujourd'hui protégé que
par la boucle locale. Interroger ne crée aucune surface nouvelle et réutilise
les bails, les réveils et la durabilité déjà en place.

Trois conséquences qui comptent :

- **Une attente ne consomme pas de tentative.** `claim_confirmation_poll`
  reprend la tentative existante au lieu d'en créer une nouvelle. Sans cela,
  quelques sondages suffiraient à épuiser `max_attempts` et la tâche échouerait
  pour « trop d'essais » alors qu'elle n'a fait qu'attendre.
- **Un refus humain ne se retente pas.** `confirmation_rejected` et
  `confirmation_expired` font échouer la tâche franchement : réessayer, même
  vers un autre agent, rouvrirait la même confirmation et redemanderait la même
  décision. La santé du profil reste intacte — un refus humain n'est pas une
  défaillance d'agent.
- **Les confirmations dues passent avant le travail neuf.** Un run déjà ouvert
  côté Agent Core retient tout le DAG qui en dépend.

La décision humaine, elle, passe par la surface utilisateur existante :
`POST /api/v1/agent-core/runs/:runId/confirmation`. Le run délégué appartient au
propriétaire de la mission, donc il s'approuve depuis le tableau de bord sans
rien de spécifique.

Lire un run sous assertion exige une vérification de portée **double** —
propriétaire et mission — d'où la colonne `agent_run_snapshots.missionExternalKey`.
Sans elle, une assertion de mission ouvrirait aussi les runs que le propriétaire
a lancés depuis ses conversations privées.

### Le scénario complet, éprouvé

`services/api/scripts/e2e-confirmation.mjs` fait tourner la chaîne entière avec
**deux vrais processus** :

```
mission → tâche Agent Core → outil à risque → awaiting_confirmation
→ redémarrage du moteur (SIGTERM puis relance) → approbation par la surface
utilisateur → reprise → tâche succeeded → mission succeeded
```

Quatorze étapes vérifiées, dont le retrait des assertions à la clôture. Un job
CI dédié le rejoue à chaque poussée.

**Ce qui est réel** : l'API Fastify, PostgreSQL, le processus Python du moteur,
sa base SQLite, le HTTP entre les deux, l'authentification de service et les
assertions signées. Le redémarrage est un vrai arrêt de processus — c'est ce qui
prouve que l'attente vit en base et non en mémoire.

**Ce qui est simulé** : le modèle, scripté pour réclamer un outil à risque puis
répondre une fois l'accord donné. C'est la seule façon de rendre le scénario
déterministe, et la séparation est volontaire : l'outil de démonstration exige
une confirmation mais ne fait rien — il rend une chaîne. Un outil à effet réel
rendrait ce test dangereux à relancer, pour aucun gain : ce qu'on éprouve est la
suspension et la reprise, pas l'effet de l'outil.

### Ce qui fonctionne réellement, et ce qui manque

Vérifié de bout en bout, par HTTP réel entre les deux processus : une tâche
`agent-core` atteint Agent Core, exécute un run et rend sa réponse ; une
signature forgée, un service non listé, une assertion hors de sa portée et une
absence d'assertion sont tous refusés en `auth_required` ; la conversation et le
run sont persistés dans PostgreSQL et appartiennent au propriétaire.

Vérifié également par HTTP réel : le moteur relit un run avec l'assertion de sa
mission, et se fait refuser avec l'assertion d'une autre mission comme sur un
run que le propriétaire a lancé lui-même.

**Non fait, et à savoir avant de s'appuyer dessus** :

- **Le smoke test à vrai agent reste à faire.** Le scénario complet est couvert
  de façon déterministe (voir ci-dessus), mais personne n'a encore vérifié qu'un
  vrai agent, livré à lui-même, réclame bien un outil à risque et que la carte
  de confirmation s'affiche correctement dans le tableau de bord. Le modèle ne
  réclame pas un outil dangereux sur commande ; cette vérification-là est
  manuelle par nature.
- **L'authentification API → moteur existe mais n'est pas activée par
  défaut** : elle attend une clé de signature persistante côté API, faute de
  quoi il n'y a pas de clé publique à provisionner. Le mécanisme est en place
  et testé ; tant qu'il n'est pas configuré, le port 18100 reste protégé par la
  seule boucle locale, et le démarrage le dit.

## Surface exposée

- santé, profils ACP et vérification du journal d'audit ;
- création et lecture de comptes fictifs EUR ;
- création et lecture de marchés fictifs ;
- ajout de cotations fictives ;
- soumission idempotente d'une recherche multi-agents ;
- lecture du résultat d'une recherche.
- soumission et suivi d'un DAG ACP générique depuis la conversation NEXUS ;
- délégation d'une tâche du DAG à Agent Core, sous identité propriétaire signée.

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
