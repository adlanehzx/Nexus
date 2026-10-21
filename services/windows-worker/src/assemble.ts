import { expandTilde, type DevicePolicy } from "@nexus/device-policy";
import type { WorkerConfig } from "./config.js";
import { LocalCapabilityRegistry, type LocalCapability } from "@nexus/worker-core";
import { createTerminalCapability } from "./capabilities/terminal.js";
import {
  createFilesystemReadCapability,
  createFilesystemWriteCapability,
} from "./capabilities/filesystem.js";
import {
  OwnedProcessRegistry,
  createProcessListCapability,
  createProcessStartCapability,
  createProcessStopCapability,
} from "./capabilities/process.js";
import { createDockerCapability } from "./capabilities/docker.js";
import { createGitCapabilities } from "./capabilities/git.js";
import { createBrowserOpenCapability } from "./capabilities/browser.js";
import { createAppOpenCapability } from "./capabilities/app.js";
import { DEFAULT_ALLOWED_ENV, ExecPolicy } from "./policy/exec-policy.js";
import { PathPolicy } from "./policy/path-policy.js";
import { DockerPolicy } from "./policy/docker-policy.js";
import { GitPolicy } from "./policy/git-policy.js";
import { NodeProcessRunner, type ProcessRunner } from "./runtime/process-runner.js";
import { NodeFileSystem, type FileSystemPort } from "./runtime/file-system.js";

/**
 * Assemblage du worker.
 *
 * Un seul endroit relie les politiques, les ports système et les capacités. Le
 * reste du code ne construit rien : il reçoit ce dont il a besoin. C'est ce qui
 * permet aux tests de remplacer `ProcessRunner` et `FileSystemPort` sans
 * toucher à une seule capacité — et donc de tout éprouver, y compris `git.pull`
 * et `process.stop`, sans jamais lancer un processus sur la machine.
 *
 * Rien dans ce fichier ne dépend de *quelle* machine Windows exécute le code.
 * Le portable et le poste fixe passent par ces mêmes lignes ; ce qui les
 * distingue tient dans `WorkerConfig` et dans ce que le cœur a enregistré.
 */

export interface AssembleOptions {
  config: WorkerConfig;
  /** Ports système. Remplacés en test ; réels en production. */
  runner?: ProcessRunner;
  fileSystem?: FileSystemPort;
  env?: Record<string, string | undefined>;
  /**
   * Politique locale, si un fichier en déclare une.
   *
   * Absente, le worker se règle sur ses variables d'environnement, comme avant
   * — l'ajout est donc sans effet sur une installation existante. Présente,
   * elle **remplace** les réglages correspondants : il ne peut y avoir deux
   * sources de vérité sur ce qu'une machine autorise, et deviner laquelle gagne
   * est exactement le genre d'ambiguïté qui finit par ouvrir un accès.
   */
  devicePolicy?: DevicePolicy;
}

export interface AssembledWorker {
  capabilities: LocalCapabilityRegistry;
  pathPolicy: PathPolicy;
  execPolicy: ExecPolicy;
  dockerPolicy: DockerPolicy;
  gitPolicy: GitPolicy;
  ownedProcesses: OwnedProcessRegistry;
}

export function assembleCapabilities(options: AssembleOptions): AssembledWorker {
  const { config } = options;
  const runner = options.runner ?? new NodeProcessRunner();
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const env = options.env ?? process.env;

  const policy = options.devicePolicy;

  const pathPolicy = new PathPolicy({
    allowedRoots:
      policy === undefined
        ? config.allowedPaths
        : policy.filesystem.allow.map((entry) => expandTilde(entry)),
    ...(policy === undefined
      ? {}
      : {
          deniedPaths: policy.filesystem.deny.under.map((entry) => expandTilde(entry)),
          deniedSegments: policy.filesystem.deny.segments,
          deniedNames: policy.filesystem.deny.names,
        }),
    realpath: (candidate) => fileSystem.realpath(candidate),
  });
  const execPolicy = new ExecPolicy({
    allowedExecutables:
      policy === undefined ? config.allowedExecutables : policy.exec.allowedExecutables,
    allowedEnv: policy === undefined ? config.allowedEnv : policy.exec.allowedEnv,
  });
  const dockerPolicy = new DockerPolicy({
    allowedSubcommands:
      policy === undefined ? config.dockerAllowed : policy.docker.allowedSubcommands,
  });
  const gitPolicy = new GitPolicy({
    allowWrite: policy === undefined ? config.gitAllowWrite : policy.git.allowWrite,
  });
  const ownedProcesses = new OwnedProcessRegistry();

  const processDependencies = {
    runner,
    execPolicy,
    pathPolicy,
    owned: ownedProcesses,
    env,
  };

  const capabilities = new LocalCapabilityRegistry(config.declaredCapabilities);

  // `exec.mode: disabled` ne filtre pas une liste d'autorisations : les
  // capacités d'exécution ne sont **pas enregistrées du tout**.
  //
  // La nuance a de l'importance, et je l'ai découverte en exécutant le test :
  // la liste `declaredCapabilities` vide signifie « toutes celles disponibles »,
  // donc la filtrer n'enlevait rien. Ne pas enregistrer la capacité est à la
  // fois le comportement correct et le plus honnête — le cœur apprend que cette
  // machine ne sait pas exécuter, au lieu de lui envoyer des tâches qu'elle
  // refusera une par une, ce qui ressemblerait à une panne.
  const execAllowed = policy?.exec.mode !== "disabled";

  capabilities.registerAll([
    ...(execAllowed
      ? [
          createTerminalCapability({
            execPolicy,
            pathPolicy,
            runner,
            env,
            defaultTimeoutMs: config.taskTimeoutMs,
          }),
          createProcessStartCapability(processDependencies),
        ]
      : []),
    createFilesystemReadCapability({ pathPolicy, fileSystem }),
    createFilesystemWriteCapability({ pathPolicy, fileSystem }),
    createProcessListCapability(processDependencies),
    createProcessStopCapability(processDependencies),
    createDockerCapability({
      policy: dockerPolicy,
      runner,
      env,
      defaultTimeoutMs: config.taskTimeoutMs,
    }),
    ...createGitCapabilities({
      policy: gitPolicy,
      pathPolicy,
      runner,
      env,
      defaultTimeoutMs: config.taskTimeoutMs,
    }),
    createBrowserOpenCapability({ runner, env }),
    createAppOpenCapability({
      runner,
      applications: config.applications,
      env,
      // Une application graphique n'a pas besoin de plus que ce qu'un
      // processus enfant reçoit déjà : l'environnement du worker contient le
      // chemin de la clé privée de l'appareil.
      allowedEnv: config.allowedEnv.length > 0 ? config.allowedEnv : DEFAULT_ALLOWED_ENV,
    }),
  ] as unknown as LocalCapability<never, unknown>[]);

  return { capabilities, pathPolicy, execPolicy, dockerPolicy, gitPolicy, ownedProcesses };
}
