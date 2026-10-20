# NEXUS V1.1.0 — accès Tailscale

Le transport privé est **en service** depuis le 2026-09-07 : les clients et les
workers joignent le cœur par `https://adlane.tail9a479d.ts.net`, jamais par une
adresse de machine. Ce document dit ce qui a été mesuré, et ce qui reste à faire.

Tailscale ne change ni les sessions, ni le protocole WebSocket, ni le
provisioning. C'est une couche de transport : l'identité d'appareil, les états
TRUSTED/PENDING/REVOKED, les capacités, les autorisations et les confirmations
restent exclusivement NEXUS. **Être sur le tailnet ne rend aucun appareil
fiable.**

## État audité (2026-09-07)

Tout ce qui suit a été **mesuré sur le poste**, pas déduit d'une configuration.

| Point                                | État                                         | Preuve                   |
| ------------------------------------ | -------------------------------------------- | ------------------------ |
| Nœud Core                            | `adlane`, Windows, Tailscale actif           | `tailscale status`       |
| MagicDNS                             | actif, suffixe `tail9a479d.ts.net`           | `tailscale dns status`   |
| FQDN                                 | `adlane.tail9a479d.ts.net` → `100.90.176.40` | résolution vérifiée      |
| Pare-feu hôte                        | **activé** sur les trois profils             | `Get-NetFirewallProfile` |
| API (Core)                           | `127.0.0.1:3000` uniquement                  | `docker ps`              |
| PostgreSQL                           | `127.0.0.1:15432` uniquement                 | `docker ps`              |
| Redis                                | `127.0.0.1:6379` uniquement                  | `docker ps`              |
| Worker navigateur                    | aucun port publié                            | `docker-compose.yml`     |
| Port 3000 via IP Tailscale           | **fermé**                                    | `Test-NetConnection`     |
| Cœur joignable en direct sur `:3000` | **non**                                      | `Test-NetConnection`     |
| Tailscale Serve                      | **actif**, `tailnet only`                    | `tailscale serve status` |
| Certificat                           | Let's Encrypt, `CN=adlane.tail9a479d.ts.net` | `openssl s_client`       |
| HTTPS `/health`                      | **200**                                      | `curl` sur le FQDN       |
| WSS `/ws/client`                     | **accepté** après approbation                | poignée de main rejouée  |
| Tailscale Funnel                     | **désactivé**                                | aucune clé `AllowFunnel` |
| Politique du tailnet                 | **encore ouverte**                           | `tailscale debug netmap` |

Le blocage pare-feu constaté le 2026-09-06 est **levé** : les trois profils sont
actifs. La publication Docker sur `0.0.0.0` l'est également.

### Corrigé le 2026-09-07

PostgreSQL et Redis étaient publiés sur `0.0.0.0`, donc **joignables depuis le
tailnet** : `Test-NetConnection 100.90.176.40 -Port 5432` et `-Port 6379`
ouvraient tous deux la connexion. Redis n'a pas de mot de passe dans cette
configuration ; sa file de jobs était lisible par tout nœud du tailnet. Les deux
sont désormais liés à la boucle locale, et la fermeture a été vérifiée.

Aucun client et aucun worker ne parle à ces deux services : ils passent par le
Core, qui les joint par le réseau Docker interne sous les noms `postgres` et
`redis`. Le port publié ne sert qu'à l'outillage local.

### Particularité du poste : le port 5432 est déjà pris

`127.0.0.1:5432` est tenu par `wslrelay.exe`, qui publie les services d'une
distribution WSL — il expose aussi `::1:80`, `::1:443` et `::1:22`. Il y a donc
**un second PostgreSQL** sur cette machine, hors Docker. Un troisième, le
service Windows `postgresql-x64-17`, écoute sur `5433`.

Conséquence pratique : le conteneur ne peut pas prendre `127.0.0.1:5432`, et il
est publié sur `15432`. Conséquence à vérifier : `DATABASE_URL` de `.env` pointe
sur `localhost:5432`, c'est-à-dire **le PostgreSQL de WSL**, pas le conteneur.
L'outillage hôte — migrations Prisma, Studio, tests d'intégration — travaille
donc sur une autre base que celle du Core. Les deux portent les mêmes
migrations, ce qui masque le problème au lieu de le signaler.

### Serve : actif depuis le 2026-09-07

Serve a été autorisé sur le tailnet, puis configuré :

```powershell
tailscale serve --bg --https=443 http://127.0.0.1:3000
```

```text
https://adlane.tail9a479d.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:3000
```

Certificat émis par Let's Encrypt sur `CN=adlane.tail9a479d.ts.net`, valable du
7 septembre au 6 décembre 2026. **Funnel reste désactivé** : la configuration ne
contient aucune clé `AllowFunnel`, et `serve status` porte la mention
`tailnet only`.

Vérifié de bout en bout à travers `https://` et `wss://` :

| Geste                                               | Résultat                      |
| --------------------------------------------------- | ----------------------------- |
| `GET /health` en HTTPS                              | 200, TLS valide               |
| Inscription, enregistrement d'appareil, approbation | 201 / 201 / 200               |
| WSS avec un appareil `PENDING`                      | refusé, code 4403             |
| WSS avec un appareil `TRUSTED`                      | accepté, `device.list` accusé |

Le Core reste inaccessible sur `100.90.176.40:3000`, comme sur les ports de
PostgreSQL et de Redis.

### Le port 443 n'est pas en conflit

La crainte était fondée sur une lecture incomplète. Après activation :

```text
100.90.176.40:443              tailscaled
fd7a:115c:a1e0::a83b:b028:443  tailscaled
0.0.0.0:443                    vmnat        (VMware NAT Service)
```

`tailscaled` se lie **spécifiquement** aux adresses de l'interface Tailscale ;
`vmnat` garde le générique. Windows route vers la liaison la plus précise, et
les deux coexistent. Le service VMware n'a pas été touché, et il ne doit pas
l'être : il assure la redirection de ports vers des machines virtuelles, sans
rapport avec NEXUS.

### Blocage restant : la politique du tailnet est encore ouverte

C'est le point qui reste, et il n'est pas cosmétique. Le filtre de paquets
réellement appliqué à ce nœud — lu par `tailscale debug netmap` — est celui de
la politique par défaut :

```json
{
  "Srcs": ["100.64.0.0/11", "fd7a:115c:a1e0::/48"],
  "Dsts": [{ "Net": "0.0.0.0/0", "Ports": { "First": 0, "Last": 65535 } }],
  "IPProto": [6, 17, 1, 58]
}
```

Autrement dit : **tout nœud du tailnet peut joindre tout port de tout autre
nœud**. Aucun nœud ne porte de tag. Ce qui est demandé — client et worker vers
le Core en 443, et rien d'autre — n'est donc pas appliqué.

Ce que cela change en pratique, et ce que cela ne change pas : un worker ne
peut toujours pas joindre un autre worker **parce qu'aucun worker n'écoute sur
un port** ; la protection est architecturale, pas réseau. La politique la
rendrait explicite au lieu de la laisser reposer sur une propriété qu'un
changement futur pourrait perdre.

La politique ne se modifie pas depuis cette machine : le CLI ne sait pas
l'écrire. Il faut la console d'administration, ou l'API avec un jeton
`tskey-api-…` qui n'existe pas ici.

## Cible réseau

```text
clients et workers Tailscale -- HTTPS/WSS --> nexus-core (Tailscale Serve)
                                                |
                                         127.0.0.1:3000 (Core)
```

C'est **Serve**, jamais Funnel : Serve reste dans le tailnet, termine TLS avec
un certificat Tailscale et relaie vers la boucle locale. Le Core n'écoute que
sur `127.0.0.1:3000` — il n'est joignable qu'à travers ce relais, et le rendre
directement accessible annulerait tout l'intérêt du montage.

## Le piège de l'en-tête `Origin`

Le canal `/ws/client` vérifie l'origine avant la poignée de main. Une origine
**absente** est acceptée — un démon worker n'est pas un navigateur — mais une
origine présente et non déclarée est refusée en **403**.

Or un client React Native en envoie une, et elle n'est pas évidente : elle est
**dérivée de l'URL du socket**, `wss://` devenant `https://`. L'iPhone se
présente donc comme `https://adlane.tail9a479d.ts.net`, qu'aucun déploiement ne
pense à déclarer.

Le symptôme est trompeur : la connexion HTTPS fonctionne, le jeton est valide,
l'appareil est approuvé, et le client affiche « connexion perdue » en boucle.
Rien dans les journaux du cœur, puisque le refus a lieu avant l'authentification.

```dotenv
CORS_ORIGINS=…,https://adlane.tail9a479d.ts.net
```

**À refaire à chaque changement de nom d'hôte du tailnet.** Pour vérifier sans
téléphone, ouvrir une socket en imposant l'en-tête :

```js
new WebSocket("wss://<fqdn>/ws/client", { origin: "https://<fqdn>" });
```

Une origine inconnue — `null`, par exemple — doit continuer d'être refusée :
c'est ce qui ferme le détournement WebSocket inter-site.

## Politique à appliquer — la dernière action qui manque

À coller dans **Access controls** de la console d'administration. Deux formes,
selon qu'on veut ou non tagger les appareils.

### Forme A — sans tags, la plus simple ici

Les appareils restent la propriété du compte `adlanehzx@`, et seul le Core est
joignable, sur le seul port qui sert.

```hujson
{
  "grants": [
    {
      "src": ["autogroup:member"],
      "dst": ["100.90.176.40"],
      "ip":  ["tcp:443"],
    },
  ],
}
```

Cette politique **retire** les accès pair-à-pair : plus rien d'autre que le Core
sur 443 n'est joignable dans le tailnet. C'est exactement ce qu'on cherche —
worker vers worker, client vers worker, tout cela tombe.

Si le nœud Core est renommé ou change d'adresse, cette règle le suit mal :
préférer alors la forme B.

### Forme B — avec tags, si la flotte grandit

```hujson
{
  "tagOwners": {
    "tag:nexus-core":   ["autogroup:admin"],
    "tag:nexus-client": ["autogroup:admin"],
    "tag:nexus-worker": ["autogroup:admin"],
  },
  "grants": [
    {
      "src": ["tag:nexus-client", "tag:nexus-worker"],
      "dst": ["tag:nexus-core"],
      "ip":  ["tcp:443"],
    },
  ],
}
```

**Avant d'adopter la forme B**, savoir ce qu'un tag implique : un appareil
tagué cesse d'appartenir à un utilisateur. Il ne s'expire plus tout seul, mais
il perd aussi l'accès que lui donnait son propriétaire. Tagger l'iPhone
personnel n'est pas neutre. La forme A évite entièrement la question.

Aucune des deux ne contient de règle d'appareil à appareil : un Android ne peut
donc joindre directement ni un poste Windows ni un iPhone.

### Après application, vérifier plutôt que croire

```powershell
tailscale debug netmap | ConvertFrom-Json | Select -Expand PacketFilter
```

`Dsts` doit se réduire au Core et au port 443. Tant qu'on y lit `0.0.0.0/0` et
`0-65535`, la politique n'est pas appliquée.

## Remonter le montage depuis zéro

Si le nœud est réinstallé, l'ordre compte — le dernier point en particulier.

1. Console Tailscale : MagicDNS, puis **HTTPS Certificates**. L'émission publie
   le FQDN dans les journaux Certificate Transparency ; c'est public et sans
   remède, mais un FQDN n'est pas un secret.
2. Vérifier que Docker publie le Core sur `127.0.0.1` **avant** d'activer Serve.
3. `tailscale serve --bg --https=443 http://127.0.0.1:3000`, puis contrôler avec
   `tailscale serve status` que la mention est bien `tailnet only`.
4. Éprouver `https://<fqdn>/health` **et** `wss://<fqdn>/ws/client`. Le second
   n'est pas garanti par le premier : un relais peut servir du HTTP sans relayer
   la montée en WebSocket.
5. Appliquer la politique d'accès. Sans elle, le tailnet reste ouvert de nœud à
   nœud, quelle que soit la qualité du reste.

Ne jamais exécuter `tailscale funnel`.

## Ce qui reste à valider physiquement

Aucun appareil distant réel n'a été connecté : le seul autre nœud du tailnet,
`pc-alger-bougara`, est hors ligne depuis le 27 août 2026. Toutes les
vérifications HTTPS et WSS ci-dessus ont été faites **depuis le nœud Core
lui-même**, à travers son nom Tailscale et son certificat public — ce qui
éprouve le relais, le certificat et la montée en WebSocket, mais **pas** le
routage entre deux nœuds ni le comportement d'un iPhone sur 5G.

Tant qu'un second appareil ne s'est pas connecté, le multi-appareil physique
n'est pas validé.

## Onboarding, révocation et dépannage

- Ajouter chaque appareil au tailnet, puis effectuer son provisioning NEXUS
  habituel : Tailscale ne rend pas un appareil NEXUS fiable.
- Révoquer d'abord dans NEXUS si l'appareil ne doit plus exécuter ; retirer ou
  expirer ensuite le nœud Tailscale et son tag dans la console.
- Vérifier `tailscale status`, `tailscale ip`, `tailscale serve status`, puis
  les Grants. Ne jamais désactiver le firewall pour diagnostiquer.

Références : [Grants](https://tailscale.com/docs/reference/syntax/grants),
[HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates),
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).
