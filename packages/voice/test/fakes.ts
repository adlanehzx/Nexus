import type { ClockPort, FilePort, ProcessPort, SpawnedProcess } from "../src/ports.js";

/**
 * Doublures des ports système.
 *
 * Aucune suite de tests ne peut brancher un micro. Ce qui est éprouvé est donc
 * le **cycle de vie** : ce qu'on lance, avec quels arguments, ce qu'on tue, ce
 * qu'on supprime. C'est précisément là que vivent les erreurs coûteuses — un
 * enregistrement qui reste sur le disque, une synthèse qu'on n'arrête pas, un
 * micro qui ne se ferme jamais.
 */

export interface FakeRun {
  command: string;
  args: string[];
  stdin: string | undefined;
  killed: boolean;
}

export class FakeProcess implements ProcessPort {
  readonly runs: FakeRun[] = [];
  readonly available = new Set<string>();
  /** Sortie rendue par commande. */
  readonly outputs = new Map<string, string>();
  /** Code de sortie par commande. Défaut : 0. */
  readonly codes = new Map<string, number>();
  /** Commandes qui ne terminent pas tant qu'on ne les tue pas. */
  readonly longRunning = new Set<string>();

  /**
   * Effets de bord d'une commande, par nom.
   *
   * Un enregistreur **écrit un fichier** : sans le modéliser, le second tour
   * d'une conversation n'entend rien, parce que le WAV du premier a été
   * supprimé. La doublure doit faire ce que fait le vrai programme, sinon elle
   * teste autre chose.
   */
  readonly effects = new Map<string, (args: readonly string[]) => void>();

  spawn(command: string, args: readonly string[], stdin?: string): SpawnedProcess {
    const run: FakeRun = { command, args: [...args], stdin, killed: false };
    this.runs.push(run);
    this.effects.get(command)?.(run.args);

    let resolveExit: (code: number) => void = () => undefined;
    const exit = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    if (!this.longRunning.has(command)) resolveExit(this.codes.get(command) ?? 0);

    return {
      exit: () => exit,
      output: () => Promise.resolve(this.outputs.get(command) ?? ""),
      stderr: () => Promise.resolve(""),
      kill: () => {
        run.killed = true;
        resolveExit(143);
      },
      get running() {
        return !run.killed;
      },
    };
  }

  which(command: string): Promise<string | undefined> {
    return Promise.resolve(this.available.has(command) ? `/usr/bin/${command}` : undefined);
  }

  /** Tous les lancements d'une commande. */
  of(command: string): FakeRun[] {
    return this.runs.filter((run) => run.command === command);
  }
}

export class FakeFiles implements FilePort {
  readonly files = new Map<string, number>();
  readonly directories = new Set<string>();
  readonly removals: string[] = [];
  /** Chemins dont la suppression échoue silencieusement — le pire des cas. */
  readonly undeletable = new Set<string>();
  readonly contents = new Map<string, string>();

  mkdir(path: string): Promise<void> {
    this.directories.add(path);
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  remove(path: string): Promise<void> {
    this.removals.push(path);
    if (!this.undeletable.has(path)) this.files.delete(path);
    return Promise.resolve();
  }

  size(path: string): Promise<number | undefined> {
    return Promise.resolve(this.files.get(path));
  }

  read(path: string): Promise<string> {
    return Promise.resolve(this.contents.get(path) ?? "");
  }
}

export class FakeClock implements ClockPort {
  #now = 0;
  /** Durées demandées, dans l'ordre — sans jamais attendre réellement. */
  readonly sleeps: number[] = [];

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.#now += ms;
    return Promise.resolve();
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
