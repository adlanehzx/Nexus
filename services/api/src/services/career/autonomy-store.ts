import type { CareerAutonomySettings } from "@nexus/career";

/**
 * Persistence for the per-user career autonomy settings.
 *
 * A missing row means "never configured": the service then applies the
 * defaults, which reproduce the historical behaviour, and the scheduler leaves
 * that owner alone.
 */
export interface StoredCareerAutonomySettings {
  settings: CareerAutonomySettings;
  /** At least one non-manual action and the kill switch off. */
  active: boolean;
  updatedAt: Date;
}

export interface CareerAutonomyStore {
  get(userId: string): Promise<StoredCareerAutonomySettings | undefined>;
  save(input: {
    userId: string;
    settings: CareerAutonomySettings;
    active: boolean;
    now: Date;
  }): Promise<StoredCareerAutonomySettings>;
  /** Owners the scheduler should visit. */
  listActiveOwners(limit: number): Promise<string[]>;
}

export class InMemoryCareerAutonomyStore implements CareerAutonomyStore {
  readonly #rows = new Map<string, StoredCareerAutonomySettings>();

  get(userId: string): Promise<StoredCareerAutonomySettings | undefined> {
    const row = this.#rows.get(userId);
    return Promise.resolve(row === undefined ? undefined : structuredClone(row));
  }

  save(input: {
    userId: string;
    settings: CareerAutonomySettings;
    active: boolean;
    now: Date;
  }): Promise<StoredCareerAutonomySettings> {
    const row: StoredCareerAutonomySettings = {
      settings: structuredClone(input.settings),
      active: input.active,
      updatedAt: input.now,
    };
    this.#rows.set(input.userId, row);
    return Promise.resolve(structuredClone(row));
  }

  listActiveOwners(limit: number): Promise<string[]> {
    return Promise.resolve(
      [...this.#rows.entries()]
        .filter(([, row]) => row.active)
        .map(([userId]) => userId)
        .slice(0, limit),
    );
  }
}
