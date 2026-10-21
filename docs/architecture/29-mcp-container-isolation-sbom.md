# 29. Isolation Conteneurisée MCP, Bwrap, Contrôle Réseau et SBOM

## 1. Contexte et Objectifs

Les serveurs MCP (Model Context Protocol) exécutent des binaires ou runtimes locaux (`node`, `python`, `npx`, `uvx`, etc.) susceptibles d'être compromis, de contenir des dépendances vulnérables ou d'exfiltrer des données sensibles.

Dans NEXUS, aucun serveur MCP ne doit s'exécuter avec les privilèges complets de la machine hôte :

1. **Isolation par conteneur / bac à sable** : Chaque serveur MCP tourne dans son propre bac à sable Bubblewrap (`bwrap`) ou conteneur (`docker`).
2. **Système de fichiers en lecture seule** : Racine (`/`) montée en `--ro-bind` en lecture seule stricte.
3. **Bind mounts explicites** : Seuls les répertoires nécessaires (ex. `/workspace`) sont montés explicitement.
4. **Filtrage réseau strict** : `--unshare-net` par défaut (`allowNetwork: false`).
5. **Limites de ressources** : Plafonds stricts de mémoire (Mo), CPU shares, PIDs (contre les fork-bombs) et timeouts.
6. **Étanchéité des secrets** : Environnement scellé avec `--clearenv` ; seuls les secrets résolus depuis le trousseau sécurisé (`vault://`) sont injectés explicitement au processus.
7. **Politique d'outils et validation binaire** : Liste blanche des exécutables (`node`, `python3`, `uv`, `docker`, `bwrap`, etc.) et vérification cryptographique SHA-256 optionnelle.
8. **SBOM et traçabilité** : Génération d'un inventaire SBOM (`McpSbom`) attestant du runtime, des dépendances, de l'horodatage et de l'empreinte cryptographique scellée.

## 2. Architecture Technique (`@nexus/mcp`)

### Bac à sable Bubblewrap (`McpSandboxManager`)

Bubblewrap (`/usr/bin/bwrap`) tire parti des user namespaces non privilégiés du noyau Linux pour créer un bac à sable hermétique sans aucun démon ni privilège root :

```
NEXUS McpClient
       │
       ▼
McpSandboxManager.prepareStdio()
       │
       ├─► Validation liste blanche binaire (validateBinary)
       ├─► Contrôle d'intégrité SHA-256 (verifyFileChecksum)
       ├─► Construction arguments bwrap :
       │     --ro-bind / / (lecture seule stricte)
       │     --dev /dev --proc /proc --tmpfs /tmp
       │     --unshare-net (isolation réseau)
       │     --unshare-pid --unshare-ipc --unshare-uts
       │     --bind /ro-bind pour répertoires autorisés
       │     --clearenv + injection sélective de secrets
       ▼
StdioClientTransport (exécute bwrap de façon transparente)
```

### Schéma de Configuration (`McpSandboxPolicy`)

```typescript
export const mcpSandboxPolicySchema = z.object({
  enabled: z.boolean().default(true),
  engine: z.enum(["bwrap", "docker", "none"]).default("bwrap"),
  readOnlyRoot: z.boolean().default(true),
  bindMounts: z.array(mcpBindMountSchema).default([]),
  allowNetwork: z.boolean().default(false),
  resourceLimits: mcpResourceLimitsSchema.default(DEFAULT_MCP_RESOURCE_LIMITS),
  allowedBinaries: z.array(z.string()).default([...DEFAULT_MCP_ALLOWED_BINARIES]),
  verifyChecksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
```

### Software Bill of Materials (SBOM)

Le SBOM capture l'empreinte logicielle :

- `serverName` : Nom du serveur MCP.
- `runtime` : `node`, `python`, `container`, etc.
- `packages` : Liste des packages et sources (`npm`, `pypi`, `oci`).
- `verifiedAt` : Timestamp ISO.
- `checksum` : Empreinte SHA-256 canonique scellée.

## 3. Audit et Diagnostics

Via le gestionnaire MCP :

- `mcpManager.getSbom(name)` : Récupère le SBOM d'un serveur.
- `mcpManager.listSboms()` : Liste l'inventaire SBOM de tous les serveurs enregistrés.
