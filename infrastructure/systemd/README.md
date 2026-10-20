# Unités systemd

`nexus-browser.service` est versionnée telle quelle : elle n'utilise que des
spécificateurs systemd (`%h`, `%t`), donc elle est portable sans modification.

`nexus-mission-engine.service` ne l'est plus. Elle portait une dizaine de
chemins absolus propres à une machine — `/home/adlane/Documents/Codex/…` — ce
qui la rendait inutilisable ailleurs et faisait du déplacement du dossier une
panne silencieuse : le service démarrait sur l'ancien emplacement, ou pas du
tout, sans que rien ne le dise.

Elle est désormais **produite** à partir de l'installation détectée :

```sh
nexus setup          # écrit ~/.config/systemd/user/nexus-mission-engine.service
systemctl --user daemon-reload
nexus start
```

Le gabarit vit dans `packages/cli/src/systemd.ts`, avec ses raisons. `nexus
doctor` signale une unité dont les chemins ne correspondent plus à
l'installation courante — c'est la panne que ce changement existe pour fermer.
