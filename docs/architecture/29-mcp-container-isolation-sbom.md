# 29. MCP Container Isolation, Bwrap, Network Control, and SBOM

## 1. Context and Goals

MCP (Model Context Protocol) servers run local binaries and runtimes (`node`, `python`, `npx`, `uvx`, etc.) that could be compromised, contain vulnerable dependencies, or attempt to exfiltrate sensitive data.

In NEXUS, no MCP server may run with unrestricted privileges on the host machine:

1. **Container / Sandbox Isolation**: Each MCP server executes in its own dedicated Bubblewrap (`bwrap`) sandbox or container (`docker`).
2. **Read-Only Root Filesystem**: Root (`/`) mounted with `--ro-bind` as strictly read-only.
3. **Explicit Bind Mounts**: Only explicitly declared directories (e.g., `/workspace`) are mounted.
4. **Strict Network Filtering**: `--unshare-net` by default (`allowNetwork: false`).
5. **Resource Limits**: Enforced memory quotas (MB), CPU shares, max PIDs (fork-bomb prevention), and execution timeouts.
6. **Sealed Secrets**: Environment cleared via `--clearenv`; only secrets explicitly resolved from the secure vault (`vault://`) are injected into the child process.
7. **Tool Policy and Binary Validation**: Whitelist of allowed executables (`node`, `python3`, `uv`, `docker`, `bwrap`, etc.) with optional SHA-256 cryptographic verification.
8. **SBOM and Provenance**: Automated generation of Software Bill of Materials (`McpSbom`) recording runtime, packages, timestamp, and sealed checksum.

## 2. Technical Architecture (`@nexus/mcp`)

### Bubblewrap Sandbox (`McpSandboxManager`)

Bubblewrap (`/usr/bin/bwrap`) leverages Linux unprivileged user namespaces to build a hermetic sandbox without requiring a root daemon:

```
NEXUS McpClient
       │
       ▼
McpSandboxManager.prepareStdio()
       │
       ├─► Binary allowlist validation (validateBinary)
       ├─► SHA-256 integrity check (verifyFileChecksum)
       ├─► Bubblewrap argument construction:
       │     --ro-bind / / (strict read-only root)
       │     --dev /dev --proc /proc --tmpfs /tmp
       │     --unshare-net (network namespace isolation)
       │     --unshare-pid --unshare-ipc --unshare-uts
       │     --bind / --ro-bind for explicit directories
       │     --clearenv + selective secret injection
       ▼
StdioClientTransport (launches bwrap transparently)
```

### Configuration Schema (`McpSandboxPolicy`)

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

The SBOM captures the software fingerprint:

- `serverName`: MCP server identifier.
- `runtime`: `node`, `python`, `container`, etc.
- `packages`: List of packages and package managers (`npm`, `pypi`, `oci`).
- `verifiedAt`: ISO timestamp.
- `checksum`: Sealed canonical SHA-256 fingerprint.

## 3. Audit and Diagnostics

Via the MCP manager:

- `mcpManager.getSbom(name)`: Retrieves the SBOM for a specific server.
- `mcpManager.listSboms()`: Lists the SBOM inventory across all registered servers.
