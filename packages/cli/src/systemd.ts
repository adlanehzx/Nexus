import type { NexusPaths } from "./environment.js";

/**
 * Unités systemd, rendues depuis l'emplacement réel de l'installation.
 *
 * Le dépôt portait jusqu'ici une unité contenant une dizaine de chemins absolus
 * — `/home/adlane/Documents/Codex/2026-10-11/…` — ce qui la rendait inutilisable
 * ailleurs et faisait du déplacement du dossier une panne silencieuse. Les
 * chemins sont maintenant **dérivés** de la racine détectée, et l'unité
 * déployée est produite plutôt que recopiée.
 *
 * Pourquoi produire un fichier concret et non une unité paramétrée : systemd
 * n'interpole que quelques spécificateurs (`%h`, `%t`…), pas une racine de
 * projet. Une unité générique devrait lire sa configuration ailleurs, ce qui
 * déplacerait le problème sans le résoudre.
 */

export interface UnitRenderOptions {
  paths: NexusPaths;
  /** Exécutable `pnpm`, tel qu'il est installé sur cette machine. */
  pnpmPath: string;
  /** `PATH` à donner au service : il n'hérite pas de celui d'un shell. */
  servicePath: string;
  /** Base de l'API locale. */
  apiUrl: string;
  /** Activer l'authentification des appels entrants, si une clé est déployée. */
  publicKeyFile?: string | undefined;
  workerConcurrency?: number;
  browserCdpUrl?: string;
}

export const MISSION_ENGINE_UNIT = "nexus-mission-engine.service";
export const BROWSER_UNIT = "nexus-browser.service";

export function renderMissionEngineUnit(options: UnitRenderOptions): string {
  const { paths } = options;
  const authLine =
    options.publicKeyFile === undefined
      ? [
          "# Authentification des appels entrants INACTIVE : aucune clé publique",
          "# déployée. Le port n'est alors protégé que par la boucle locale.",
          "# `nexus setup` génère la clé et réécrit cette unité.",
        ].join("\n")
      : `Environment=NEXUS_ENGINE_API_PUBLIC_KEY_FILE=${options.publicKeyFile}`;

  return `# Généré par \`nexus setup\` — ne pas éditer à la main.
#
# Les chemins ci-dessous sont ceux de l'installation détectée à la génération.
# Déplacer le dépôt invalide cette unité : relancer \`nexus setup\` la réécrit.
[Unit]
Description=NEXUS Mission Engine - durable native ACP orchestration
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${paths.missionEngine}
Environment=NEXUS_ENGINE_DATABASE=${paths.missionEngineDatabase}
Environment=NEXUS_ENGINE_ACP_RUNNER=${paths.agentRunner}
Environment=NEXUS_ENGINE_ACP_REGISTRY=${paths.agentRegistry}
Environment=NEXUS_ENGINE_PROFILES_FILE=${paths.engineProfiles}
Environment=NEXUS_ENGINE_RUNTIME_SETTINGS_FILE=${paths.engineRuntimeSettings}
# Base de l'API NEXUS, pour les tâches déléguées à Agent Core. Boucle locale
# uniquement : l'assertion de mission part dans un en-tête Authorization, et la
# passerelle refuse toute URL HTTP qui sortirait de la machine.
Environment=NEXUS_ENGINE_API_URL=${options.apiUrl}
${authLine}
Environment=NEXUS_ENGINE_WORKER_ENABLED=true
Environment=NEXUS_ENGINE_WORKER_CONCURRENCY=${options.workerConcurrency ?? 2}
Environment=BU_CDP_URL=${options.browserCdpUrl ?? "http://127.0.0.1:19222"}
Environment=PATH=${options.servicePath}
ExecStartPre=${options.pnpmPath} --dir ${paths.root} --filter @nexus/agent build
ExecStart=${paths.missionEngineVenvBin}/nexus-mission-engine
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
RestrictSUIDSGID=true

[Install]
WantedBy=default.target
`;
}

/**
 * Chemins absolus d'une unité qui ne correspondent plus à l'installation.
 *
 * C'est la panne qu'on veut nommer : le dossier a été déplacé, l'unité pointe
 * ailleurs, et le service tourne — sur l'ancien emplacement, ou pas du tout.
 * Rien ne le signale sans cette vérification.
 */
export function foreignPaths(unitContent: string, root: string): string[] {
  const found = new Set<string>();

  // Les spécificateurs systemd (`%h`, `%t`, `%u`…) sont résolus au chargement :
  // un chemin qui en dépend est déjà portable, et le signaler reviendrait à
  // reprocher à l'unité du navigateur d'être bien écrite. On les retire avec le
  // chemin qu'ils introduisent avant d'examiner le reste.
  const withoutSpecifiers = unitContent.replace(/%[a-zA-Z]\/[^\s=:"']*/g, "");

  for (const match of withoutSpecifiers.matchAll(/(\/[^\s=:"']+)/g)) {
    const path = match[1] ?? "";
    // On ne juge que ce qui prétend être dans une installation NEXUS : le reste
    // (interpréteurs système, `PATH`) est légitimement ailleurs.
    if (!/nexus|mission-engine|services\/agent/.test(path)) continue;
    if (path.startsWith(root)) continue;
    found.add(path);
  }
  return [...found];
}
