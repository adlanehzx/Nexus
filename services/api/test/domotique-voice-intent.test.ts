import { describe, expect, it } from "vitest";
import { buildHomeDevices, type HomeAssistantSnapshot } from "@nexus/devices";
import { parseHomeIntent, targetDevices } from "../src/services/domotique/voice-intent.js";

const SNAPSHOT: Pick<HomeAssistantSnapshot, "states" | "devices" | "entities"> = {
  states: [
    {
      entity_id: "light.salon_plafond",
      state: "off",
      attributes: { friendly_name: "Plafonnier", supported_color_modes: ["hs"] },
    },
    {
      entity_id: "light.salon_lampe",
      state: "off",
      attributes: { friendly_name: "Lampe", supported_color_modes: ["brightness"] },
    },
    { entity_id: "light.cuisine", state: "off", attributes: { friendly_name: "Lumière cuisine" } },
    { entity_id: "media_player.tv", state: "playing", attributes: { friendly_name: "Télé" } },
  ],
  devices: [],
  entities: [
    { entity_id: "light.salon_plafond", device_id: null, area_id: "salon" },
    { entity_id: "light.salon_lampe", device_id: null, area_id: "salon" },
    { entity_id: "light.cuisine", device_id: null, area_id: "cuisine" },
  ],
};
const ROOMS = [
  { id: "r1", name: "Salon", haAreaId: "salon", sortOrder: 0 },
  { id: "r2", name: "Cuisine", haAreaId: "cuisine", sortOrder: 1 },
];
const devices = buildHomeDevices({ ha: SNAPSHOT, rooms: ROOMS, settings: [] });

function targets(text: string, satelliteRoom: string | null = null): string[] {
  const intent = parseHomeIntent(text);
  if (intent?.kind !== "device") throw new Error(`not a device intent: ${text}`);
  return targetDevices(intent, devices, ROOMS, satelliteRoom)
    .map((d) => d.id)
    .sort();
}

describe("satellite voice intents", () => {
  it("parses French and English home commands", () => {
    expect(parseHomeIntent("Allume la lumière du salon")).toMatchObject({
      kind: "device",
      action: { action: "turn_on" },
      domain: "light",
    });
    expect(parseHomeIntent("éteins la télé")).toMatchObject({
      action: { action: "turn_off" },
      domain: "tv",
    });
    expect(parseHomeIntent("mets la lampe à 30 %")).toMatchObject({
      action: { action: "set_brightness", brightness: 30 },
    });
    expect(parseHomeIntent("mets le salon en bleu")).toMatchObject({
      action: { action: "set_color", color: "#0000ff" },
    });
    expect(parseHomeIntent("turn off the kitchen light")).toMatchObject({
      action: { action: "turn_off" },
    });
    expect(parseHomeIntent("lance la scène cinéma")).toEqual({ kind: "scene", name: "cinema" });
    expect(parseHomeIntent("quelle est la capitale du Pérou")).toBeNull();
  });

  it("targets every light of a named room, or the satellite's own room", () => {
    expect(targets("allume la lumière du salon")).toEqual([
      "ha:light.salon_lampe",
      "ha:light.salon_plafond",
    ]);
    expect(targets("allume la lumière", "r2")).toEqual(["ha:light.cuisine"]);
    expect(targets("éteins le plafonnier")).toEqual(["ha:light.salon_plafond"]);
    expect(targets("pause la télé")).toEqual(["ha:media_player.tv"]);
  });
});
