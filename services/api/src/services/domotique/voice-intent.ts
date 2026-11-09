import {
  normalizeText,
  resolveHomeDevice,
  type HomeAction,
  type HomeDevice,
  type HomeRoom,
} from "@nexus/devices";
import type { VoiceIntentHandler } from "@nexus/voice";
import type { DomotiqueService } from "./domotique-service.js";

/**
 * Voice intent for satellites.
 *
 * Home commands ("allume la lumière du salon", "mets la lampe en bleu",
 * "pause la télé", "lance la scène cinéma") are recognised locally and
 * executed through the same `DomotiqueService.executeAction` path as the
 * dashboard and the agent tools — so sensitive devices still go through the
 * confirmation broker. Anything else is handed to the NEXUS agent when one is
 * configured.
 *
 * Without a room in the sentence, the satellite's own room is the default
 * target: "allume la lumière" in the kitchen means the kitchen.
 */

export type ParsedHomeIntent =
  | { kind: "device"; action: HomeAction; target: string; domain: string | null; all: boolean }
  | { kind: "scene"; name: string };

const COLORS: Record<string, string> = {
  rouge: "#ff0000",
  red: "#ff0000",
  vert: "#00ff00",
  green: "#00ff00",
  bleu: "#0000ff",
  blue: "#0000ff",
  blanc: "#ffffff",
  white: "#ffffff",
  jaune: "#ffd000",
  yellow: "#ffd000",
  orange: "#ff8000",
  violet: "#8000ff",
  purple: "#8000ff",
  rose: "#ff4080",
  pink: "#ff4080",
};

const DOMAIN_WORDS: [RegExp, string][] = [
  [/\b(lumieres?|lampes?|lights?|lamps?|ampoules?|plafonnier|spots?)\b/, "light"],
  [/\b(prises?|plugs?|outlets?|interrupteurs?|switch(es)?)\b/, "switch"],
  [/\b(tele|television|tv|fire tv)\b/, "tv"],
  [/\b(chauffage|radiateurs?|thermostat|heating)\b/, "climate"],
  [/\b(volets?|stores?|blinds?|shutters?)\b/, "cover"],
  [/\b(portes?|serrures?|locks?|door)\b/, "lock"],
];

const FILLER =
  /\b(allume[rsz]?|eteins?|eteindre|coupe[rsz]?|turn|switch|on|off|mets?|met|mettre|regle[rsz]?|la|le|les|l|du|de|des|d|dans|en|a|au|aux|the|in|of|to|please|stp|s il te plait|nexus|luminosite|brightness|pourcent|percent|couleur|colou?r|toutes?|tous|all|every|pause|play|lecture|reprends?|volume|son|monte|baisse|verrouille[rsz]?|deverrouille[rsz]?|lock|unlock|ouvre|ferme|open|close)\b/g;

/** Parses a transcript into a home intent, or `null` when it is not a home command. */
export function parseHomeIntent(raw: string): ParsedHomeIntent | null {
  const text = normalizeText(raw);
  if (text.length === 0) return null;

  const scene =
    /\b(?:lance|active|demarre|run|start|activate)\s+(?:la |le )?(?:scene|ambiance|mode)\s+(.+)$/.exec(
      text,
    );
  if (scene?.[1] !== undefined) return { kind: "scene", name: scene[1].trim() };

  const domain = DOMAIN_WORDS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
  const all = /\b(toutes?|tous|all|every)\b/.test(text);
  const target = text
    .replace(FILLER, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const make = (action: HomeAction): ParsedHomeIntent => ({
    kind: "device",
    action,
    target,
    domain,
    all,
  });

  const percent = /\b(\d{1,3})\s*(?:%|pour ?cent|percent)?/.exec(text);
  const color = Object.keys(COLORS).find((c) => new RegExp(`\\b${c}\\b`).test(text));

  if (/\b(deverrouille|unlock)/.test(text)) return make({ action: "unlock" });
  if (/\b(verrouille|lock)\b/.test(text)) return make({ action: "lock" });
  if (/\b(coupe le son|mute)\b/.test(text)) return make({ action: "media", command: "mute" });
  if (/\b(monte le son|plus fort|volume up|louder)\b/.test(text)) {
    return make({ action: "media", command: "volume_up" });
  }
  if (/\b(baisse le son|moins fort|volume down|quieter)\b/.test(text)) {
    return make({ action: "media", command: "volume_down" });
  }
  if (/\b(pause)\b/.test(text)) return make({ action: "media", command: "pause" });
  if (/\b(lecture|reprends?|play|resume)\b/.test(text))
    return make({ action: "media", command: "play" });
  if (/\b(ouvre|open)\b/.test(text) && domain === "cover") return make({ action: "open" });
  if (/\b(ferme|close)\b/.test(text) && domain === "cover") return make({ action: "close" });
  if (/\b(eteins?|eteindre|turn off|switch off|coupe)\b/.test(text))
    return make({ action: "turn_off" });
  if (color !== undefined && COLORS[color] !== undefined) {
    return make({ action: "set_color", color: COLORS[color] });
  }
  if (
    percent?.[1] !== undefined &&
    /\b(luminosite|brightness|%|pour ?cent|percent|mets?|regle)\b/.test(text)
  ) {
    const value = Math.min(100, Number(percent[1]));
    return make({ action: "set_brightness", brightness: value });
  }
  if (/\b(allume[rsz]?|turn on|switch on)\b/.test(text)) return make({ action: "turn_on" });
  return null;
}

function domainMatches(device: HomeDevice, domain: string | null): boolean {
  if (domain === null) return true;
  if (domain === "tv") return device.domain === "fire_tv" || device.domain === "media_player";
  return device.domain === domain;
}

/** Picks the devices an intent addresses. Prefers the satellite's room when none is named. */
export function targetDevices(
  intent: Extract<ParsedHomeIntent, { kind: "device" }>,
  devices: readonly HomeDevice[],
  rooms: readonly HomeRoom[],
  satelliteRoomId: string | null,
): HomeDevice[] {
  const capable = devices.filter((d) => d.source !== "nexus_worker" && d.source !== "satellite");
  const namedRoom = rooms.find((r) => {
    const name = normalizeText(r.name);
    return name.length > 0 && new RegExp(`\\b${name}\\b`).test(intent.target);
  });
  const roomId = namedRoom?.id ?? null;
  const inRoom = (d: HomeDevice, id: string | null) => id === null || d.roomId === id;

  // "toutes les lumières (du salon)" / "la lumière du salon": every device of that kind there.
  if (intent.domain !== null && (intent.all || roomId !== null)) {
    const group = capable.filter((d) => domainMatches(d, intent.domain) && inRoom(d, roomId));
    if (group.length > 0) return group;
  }
  const remaining =
    roomId === null
      ? intent.target
      : intent.target.replace(normalizeText(namedRoom?.name ?? ""), " ").trim();
  if (remaining.length > 0) {
    const matches = resolveHomeDevice(capable, rooms, remaining).filter(
      (d) => domainMatches(d, intent.domain) && inRoom(d, roomId),
    );
    if (matches.length === 1) return matches;
    if (matches.length > 1 && satelliteRoomId !== null) {
      const local = matches.filter((d) => d.roomId === satelliteRoomId);
      if (local.length > 0) return local;
    }
    if (matches.length > 0) return matches.slice(0, 1);
  }
  if (intent.domain !== null) {
    const local = capable.filter(
      (d) => domainMatches(d, intent.domain) && inRoom(d, roomId ?? satelliteRoomId),
    );
    if (local.length > 0) return local;
    const anywhere = capable.filter((d) => domainMatches(d, intent.domain));
    if (anywhere.length === 1) return anywhere;
  }
  return [];
}

export interface AgentFallback {
  ask(input: { ownerId: string; satelliteId: string; text: string }): Promise<string | undefined>;
}

export interface HomeVoiceIntentOptions {
  readonly domotique: DomotiqueService;
  readonly ownerOf: (satelliteId: string) => string | undefined;
  readonly agent?: AgentFallback | undefined;
}

export class HomeVoiceIntentHandler implements VoiceIntentHandler {
  readonly #o: HomeVoiceIntentOptions;

  constructor(options: HomeVoiceIntentOptions) {
    this.#o = options;
  }

  async handle(input: { satelliteId: string; text: string }): Promise<{ reply: string }> {
    const ownerId = this.#o.ownerOf(input.satelliteId);
    if (ownerId === undefined) return { reply: "Ce satellite n'est associé à aucun compte." };
    const intent = parseHomeIntent(input.text);
    if (intent === null) {
      const answer = await this.#o.agent?.ask({
        ownerId,
        satelliteId: input.satelliteId,
        text: input.text,
      });
      return { reply: answer ?? "Je ne sais pas encore faire ça." };
    }

    const domotique = this.#o.domotique;
    if (intent.kind === "scene") {
      const wanted = normalizeText(intent.name);
      const scene = (await domotique.listScenes(ownerId)).find(
        (s) => normalizeText(s.name) === wanted,
      );
      if (scene === undefined) return { reply: `Je ne trouve pas la scène ${intent.name}.` };
      const result = await domotique.runScene({
        ownerId,
        sceneId: scene.id,
        origin: "voice",
        confirmed: false,
      });
      return {
        reply:
          result.status === "pending_confirmation"
            ? `La scène ${scene.name} touche un appareil sensible : confirme-la sur le tableau de bord.`
            : result.status === "succeeded"
              ? `Scène ${scene.name} lancée.`
              : `La scène ${scene.name} ne s'est pas entièrement exécutée.`,
      };
    }

    const [devices, rooms] = await Promise.all([
      domotique.listDevices(ownerId),
      domotique.listRooms(ownerId),
    ]);
    const satelliteRoom = devices.find((d) => d.id === `sat:${input.satelliteId}`)?.roomId ?? null;
    const targets = targetDevices(intent, devices, rooms, satelliteRoom).filter((d) =>
      d.capabilities.includes(actionCapability(intent.action)),
    );
    if (targets.length === 0) return { reply: "Je n'ai pas trouvé l'appareil concerné." };

    const outcomes = [];
    for (const device of targets) {
      outcomes.push(
        await domotique
          .executeAction({
            ownerId,
            deviceId: device.id,
            action: intent.action,
            origin: "voice",
            confirmed: false,
          })
          .catch(() => ({ status: "failed" as const, message: "", deviceId: device.id })),
      );
    }
    const names = targets.map((d) => d.name).join(", ");
    if (outcomes.some((o) => o.status === "pending_confirmation")) {
      return {
        reply: `${names} est un appareil sensible : confirme l'action sur le tableau de bord.`,
      };
    }
    if (outcomes.every((o) => o.status === "succeeded")) return { reply: `C'est fait : ${names}.` };
    if (outcomes.every((o) => o.status === "failed")) return { reply: `Échec pour ${names}.` };
    return { reply: `Fait en partie : ${names}.` };
  }
}

function actionCapability(action: HomeAction): HomeDevice["capabilities"][number] {
  switch (action.action) {
    case "set_brightness":
      return "brightness";
    case "set_color":
      return "color";
    case "media":
      return "media";
    case "lock":
    case "unlock":
      return "lock";
    case "open":
    case "close":
    case "stop":
      return "cover";
    default:
      return "onoff";
  }
}

/** Structural slice of the agent orchestrator and conversation store used by the fallback. */
export interface AgentFallbackDeps {
  readonly run: (input: {
    userId: string;
    conversationId: string;
    message: string;
  }) => Promise<{ record: { response: string | null; runId: string } }>;
  readonly conversations: {
    create(input: { userId: string; title: string }): Promise<{ id: string }>;
    appendMessage(input: {
      conversationId: string;
      role: "user" | "assistant";
      content: string;
      originClientDeviceId: null;
      id?: string;
    }): Promise<unknown>;
  };
}

/**
 * Non-home requests go to the NEXUS agent, in one conversation per satellite
 * so follow-up questions keep their context. Replies are capped: they are
 * spoken aloud.
 */
export function createAgentFallback(deps: AgentFallbackDeps): AgentFallback {
  const conversations = new Map<string, string>();
  return {
    ask: async ({ ownerId, satelliteId, text }) => {
      const key = `${ownerId}:${satelliteId}`;
      let conversationId = conversations.get(key);
      if (conversationId === undefined) {
        conversationId = (
          await deps.conversations.create({ userId: ownerId, title: `Satellite ${satelliteId}` })
        ).id;
        conversations.set(key, conversationId);
      }
      const result = await deps.run({ userId: ownerId, conversationId, message: text });
      await deps.conversations.appendMessage({
        conversationId,
        role: "user",
        content: text,
        originClientDeviceId: null,
      });
      const response = result.record.response;
      if (response === null) return undefined;
      await deps.conversations.appendMessage({
        id: result.record.runId,
        conversationId,
        role: "assistant",
        content: response,
        originClientDeviceId: null,
      });
      return response.replace(/[*_`#>]/g, "").slice(0, 600);
    },
  };
}
