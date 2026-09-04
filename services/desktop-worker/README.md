# Device Agent — remplacé

> **Ce dossier ne contient aucune implémentation, et n'en contiendra pas.**

Le rôle prévu ici — un démon Node installé sur le PC, connecté au cœur en WebSocket
sortant, exécutant des tâches sous sa propre politique locale — est rempli par
[`services/windows-worker`](../windows-worker/), qui est implémenté et testé.

Le nom a changé avec la raison : ce n'est pas « le worker du desktop », c'est
**l'exécutant Windows**, et le même binaire tourne sur le portable et sur le poste fixe.
Rien dans ce paquet ne sait sur lequel des deux il s'exécute — c'est le registre, côté
cœur, qui distingue un rôle `BOTH` d'un rôle `WORKER`.

Le runtime commun à tous les exécutants — Windows et Android — vit dans
[`packages/worker-core`](../../packages/worker-core/).

Le dossier reste en place pour ne pas casser les liens des documents d'architecture
antérieurs. Il sera supprimé quand ils auront été relus.

## Référence

- Exécutant Windows : [`services/windows-worker/README.md`](../windows-worker/README.md)
- Client Windows : [`apps/desktop/README.md`](../../apps/desktop/README.md)
- ADR : [`docs/adr/ADR-007-device-agent-node.md`](../../docs/adr/ADR-007-device-agent-node.md)
