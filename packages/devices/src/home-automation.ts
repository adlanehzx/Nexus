import { z } from "zod";
import { actionIsSensitive, homeActionSchema, type HomeAction, type HomeDevice } from "./home.js";

/**
 * Scenes and routines, executed by NEXUS (not by Home Assistant).
 *
 * A scene is a named set of device actions. A routine is
 * `trigger → conditions → actions`. Triggers: a 5-field cron expression
 * evaluated in the owner's timezone, a device state change, or a presence
 * event (accepted and stored, but not evaluated until a presence source exists).
 *
 * This module is pure: it decides *what* should run. Executing actions, the
 * confirmation gate for sensitive devices, and the execution log belong to
 * the caller.
 */

export const sceneActionSchema = z.object({
  deviceId: z.string().min(1).max(200),
  action: homeActionSchema,
});
export type SceneAction = z.infer<typeof sceneActionSchema>;

export const sceneInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  actions: z.array(sceneActionSchema).min(1).max(50),
});
export type SceneInput = z.infer<typeof sceneInputSchema>;

export interface HomeScene extends SceneInput {
  readonly id: string;
  readonly ownerId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const routineTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("time"),
    cron: z.string().refine((value) => parseCron(value) !== null, "invalid cron expression"),
  }),
  z.object({
    type: z.literal("device_state"),
    deviceId: z.string().min(1).max(200),
    /** Raw state to match (`on`, `off`, `playing`...). Omitted = any change. */
    to: z.string().max(64).optional(),
    from: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal("presence"),
    event: z.enum(["arrive", "leave"]),
    person: z.string().max(80).optional(),
  }),
]);
export type RoutineTrigger = z.infer<typeof routineTriggerSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

export const routineConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("time_between"), after: hhmm, before: hhmm }),
  z.object({
    type: z.literal("weekday"),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
  z.object({
    type: z.literal("device_state"),
    deviceId: z.string().min(1).max(200),
    state: z.string().max(64),
  }),
]);
export type RoutineCondition = z.infer<typeof routineConditionSchema>;

export const routineActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("device"),
    deviceId: z.string().min(1).max(200),
    action: homeActionSchema,
  }),
  z.object({ type: z.literal("scene"), sceneId: z.string().min(1).max(64) }),
]);
export type RoutineAction = z.infer<typeof routineActionSchema>;

export const routineInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  trigger: routineTriggerSchema,
  conditions: z.array(routineConditionSchema).max(10).default([]),
  actions: z.array(routineActionSchema).min(1).max(50),
});
export type RoutineInput = z.infer<typeof routineInputSchema>;

export interface HomeRoutine {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: RoutineTrigger;
  readonly conditions: readonly RoutineCondition[];
  readonly actions: readonly RoutineAction[];
  readonly lastRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type HomeExecutionKind = "action" | "scene" | "routine";
export type HomeExecutionStatus =
  "succeeded" | "partial" | "failed" | "pending_confirmation" | "rejected" | "skipped";

export interface HomeExecutionLogEntry {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: HomeExecutionKind;
  readonly refId: string | null;
  readonly name: string;
  readonly status: HomeExecutionStatus;
  readonly origin: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron
// ─────────────────────────────────────────────────────────────────────────────

export interface CronSpec {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly dayRestricted: boolean;
  readonly weekdayRestricted: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (match === null) return null;
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let start = min;
    let end = max;
    if (range !== "*" && range !== undefined) {
      const [a, b] = range.split("-").map(Number);
      if (a === undefined) return null;
      start = a;
      end = b ?? (stepText === undefined ? a : max);
    }
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

/** Parses `minute hour day-of-month month day-of-week` (0 or 7 = Sunday). */
export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const minutes = parseField(m, 0, 59);
  const hours = parseField(h, 0, 23);
  const days = parseField(dom, 1, 31);
  const months = parseField(mon, 1, 12);
  const weekdaysRaw = parseField(dow, 0, 7);
  if (!minutes || !hours || !days || !months || !weekdaysRaw) return null;
  const weekdays = new Set([...weekdaysRaw].map((d) => (d === 7 ? 0 : d)));
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    dayRestricted: dom !== "*",
    weekdayRestricted: dow !== "*",
  };
}

export interface ZonedParts {
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly month: number;
  readonly weekday: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `date` in `timeZone` (IANA). */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")) % 24,
    day: Number(get("day")),
    month: Number(get("month")),
    weekday: WEEKDAY[get("weekday")] ?? 0,
  };
}

export function cronMatches(spec: CronSpec, at: ZonedParts): boolean {
  if (!spec.minutes.has(at.minute) || !spec.hours.has(at.hour) || !spec.months.has(at.month)) {
    return false;
  }
  const dayOk = spec.days.has(at.day);
  const weekdayOk = spec.weekdays.has(at.weekday);
  // Standard cron: when both day fields are restricted, either may match.
  if (spec.dayRestricted && spec.weekdayRestricted) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

function minutesOf(hhmmValue: string): number {
  const [h, m] = hhmmValue.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function conditionsHold(
  conditions: readonly RoutineCondition[],
  at: ZonedParts,
  deviceState: (deviceId: string) => string | undefined,
): boolean {
  return conditions.every((condition) => {
    switch (condition.type) {
      case "time_between": {
        const now = at.hour * 60 + at.minute;
        const after = minutesOf(condition.after);
        const before = minutesOf(condition.before);
        // Window crossing midnight, e.g. 22:00 → 06:00.
        return after <= before ? now >= after && now < before : now >= after || now < before;
      }
      case "weekday":
        return condition.days.includes(at.weekday);
      case "device_state":
        return deviceState(condition.deviceId) === condition.state;
    }
  });
}

/** Routines whose `time` trigger fires at this minute. */
export function dueTimeRoutines(routines: readonly HomeRoutine[], at: ZonedParts): HomeRoutine[] {
  return routines.filter((routine) => {
    if (!routine.enabled || routine.trigger.type !== "time") return false;
    const spec = parseCron(routine.trigger.cron);
    return spec !== null && cronMatches(spec, at);
  });
}

/** Routines whose `device_state` trigger matches this transition. */
export function stateTriggeredRoutines(
  routines: readonly HomeRoutine[],
  change: { deviceId: string; from: string | null; to: string | null },
): HomeRoutine[] {
  if (change.from === change.to) return [];
  return routines.filter((routine) => {
    if (!routine.enabled || routine.trigger.type !== "device_state") return false;
    const trigger = routine.trigger;
    if (trigger.deviceId !== change.deviceId) return false;
    if (trigger.to !== undefined && trigger.to !== change.to) return false;
    if (trigger.from !== undefined && trigger.from !== change.from) return false;
    return true;
  });
}

/** Expands routine actions into concrete device actions (scenes inlined). */
export function expandRoutineActions(
  actions: readonly RoutineAction[],
  scenes: readonly HomeScene[],
): { deviceId: string; action: HomeAction; via: string | null }[] {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const out: { deviceId: string; action: HomeAction; via: string | null }[] = [];
  for (const item of actions) {
    if (item.type === "device")
      out.push({ deviceId: item.deviceId, action: item.action, via: null });
    else {
      const scene = byId.get(item.sceneId);
      if (scene === undefined) continue;
      for (const a of scene.actions)
        out.push({ deviceId: a.deviceId, action: a.action, via: scene.id });
    }
  }
  return out;
}

/** Device ids whose action in this list needs human confirmation. */
export function sensitiveTargets(
  actions: readonly { deviceId: string; action: HomeAction }[],
  devices: readonly HomeDevice[],
): string[] {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const ids = actions
    .filter((a) => {
      const device = byId.get(a.deviceId);
      return device !== undefined && actionIsSensitive(device, a.action);
    })
    .map((a) => a.deviceId);
  return [...new Set(ids)];
}
