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

  const pathPolicy = new PathPolicy({
    allowedRoots: config.allowedPaths,
    realpath: (candidate) => fileSystem.realpath(candidate),
  });
  const execPolicy = new ExecPolicy({
    allowedExecutables: config.allowedExecutables,
    allowedEnv: config.allowedEnv,
  });
  const dockerPolicy = new DockerPolicy({ allowedSubcommands: config.dockerAllowed });
  const gitPolicy = new GitPolicy({ allowWrite: config.gitAllowWrite });
  const ownedProcesses = new OwnedProcessRegistry();

  const processDependencies = {
    runner,
    execPolicy,
    pathPolicy,
    owned: ownedProcesses,
    env,
  };

  const capabilities = new LocalCapabilityRegistry(config.declaredCapabilities);

  capabilities.registerAll([
    createTerminalCapability({
      execPolicy,
      pathPolicy,
      runner,
      env,
      defaultTimeoutMs: config.taskTimeoutMs,
    }),
    createFilesystemReadCapability({ pathPolicy, fileSystem }),
    createFilesystemWriteCapability({ pathPolicy, fileSystem }),
    createProcessListCapability(processDependencies),
    createProcessStartCapability(processDependencies),
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
