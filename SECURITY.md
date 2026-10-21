# Politique de sécurité

## Versions prises en charge

NEXUS est en alpha. Seul le dernier commit de la branche par défaut et la dernière release sont
pris en charge. Les releases antérieures peuvent recevoir un correctif uniquement si une mise à
jour immédiate est impossible.

## Signaler une vulnérabilité

Utilisez le **signalement privé de vulnérabilité GitHub** du dépôt. Ne créez pas d'issue publique
et ne joignez jamais de vrais jetons, cookies, clés privées ou exports de session. Fournissez :

- le composant et la version concernés ;
- l'impact et les préconditions ;
- un cas de reproduction minimal avec des identifiants factices ;
- une correction proposée, si disponible.

Un accusé de réception est visé sous 72 heures. La divulgation coordonnée a lieu après mise à
disposition d'un correctif et d'un avis de sécurité.

## Frontières de confiance

- Les agents ACP et serveurs MCP sont des processus externes potentiellement hostiles.
- Les sorties de modèle et contenus web sont des données non fiables, jamais des instructions
  système.
- Les secrets doivent être injectés au processus concerné et ne doivent jamais entrer dans les
  prompts, journaux, traces ou réponses API.
- Une opération irréversible ou à risque exige une politique explicite et, lorsque prévu, une
  confirmation humaine liée aux arguments exacts.

Les problèmes de disponibilité sans impact de sécurité peuvent être signalés par une issue.
