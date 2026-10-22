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
 * Worker assembly.
 *
 * Connects policies, system ports, and capabilities in a single location.
 */

export interface AssembleOptions {
  config: WorkerConfig;
  runner?: ProcessRunner;
  fileSystem?: FileSystemPort;
  env?: Record<string, string | undefined>;
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
      allowedEnv: config.allowedEnv.length > 0 ? config.allowedEnv : DEFAULT_ALLOWED_ENV,
    }),
  ] as unknown as LocalCapability<never, unknown>[]);

  return { capabilities, pathPolicy, execPolicy, dockerPolicy, gitPolicy, ownedProcesses };
}
