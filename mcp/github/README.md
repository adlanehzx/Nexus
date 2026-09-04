# Serveur MCP — github

> **Il n'y a rien à écrire ici.** Le serveur MCP `github` est un logiciel tiers
> qu'on **configure**, pas qu'on développe.

## Utilisation

Une configuration prête à l'emploi, politique de permission comprise, vit dans
[`packages/mcp/src/presets.ts`](../../packages/mcp/src/presets.ts) :

```ts
import { githubPreset } from "@nexus/mcp";
```

## Référence

- Comment ajouter un serveur MCP : [`packages/mcp/README.md`](../../packages/mcp/README.md)
- Architecture : [`docs/architecture/17-mcp.md`](../../docs/architecture/17-mcp.md)

Ce dossier reste réservé au cas où NEXUS aurait un jour à **exposer** ses propres
capacités en tant que serveur MCP — l'inverse du besoin actuel.
