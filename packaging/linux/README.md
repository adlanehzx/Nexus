# Worker Linux, NAS et Raspberry Pi

Le worker est distribué comme une image multiarchitecture (`amd64` et `arm64`).
Il ne publie aucun port : sa connexion WebSocket vers NEXUS est uniquement
sortante.

Depuis **NEXUS → Appareils**, créez un ticket puis, sur la machine Linux :

```sh
./install-worker.sh https://nexus.exemple.fr TICKET_USAGE_UNIQUE /srv/nexus-workspace
```

Le conteneur est en lecture seule, sans capability Linux, et ne voit que le
dossier explicitement monté dans `/workspace`. Le socket Docker de l'hôte n'est
pas monté. Pour retirer la machine, révoquez-la d'abord dans NEXUS, puis lancez
`docker rm -f nexus-worker`; les clés restent dans
`~/.local/share/nexus-worker` jusqu'à leur suppression volontaire.
