import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Les icônes du paquet doivent être en **RGBA**.
 *
 * Ce test existe parce que ce défaut a coûté une exécution de CI entière. Les
 * icônes avaient été produites depuis une source RGB, sans canal alpha ; Tauri
 * exige RGBA et son macro `generate_context!` échoue à la compilation avec
 * « icon 32x32.png is not RGBA ».
 *
 * Deux raisons de le vérifier ici plutôt que de compter sur la compilation :
 *
 *  1. la compilation Rust prend plusieurs minutes et n'existe que dans un job
 *     dédié, alors que ce test se lance en millisecondes avec le reste ;
 *  2. l'erreur de Tauri arrive **après** la résolution de toutes les
 *     dépendances, c'est-à-dire au pire endroit pour une faute d'un octet dans
 *     un en-tête PNG.
 *
 * On lit l'en-tête PNG à la main : ajouter une bibliothèque d'images pour lire
 * treize octets serait une dépendance de plus dans la chaîne d'un paquet qu'on
 * veut pouvoir reconstruire.
 */

const ICONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src-tauri", "icons");

/** Type de couleur PNG : 6 = RGBA, 2 = RGB, 3 = palette, 0 = gris. */
function pngColorType(path: string): { colorType: number; width: number; height: number } {
  const header = readFileSync(path).subarray(0, 26);
  const signature = header.subarray(0, 8);
  expect([...signature], `${path} : signature PNG`).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return {
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
    colorType: header.readUInt8(25),
  };
}

describe("icônes du paquet", () => {
  const attendues = [
    { fichier: "32x32.png", taille: 32 },
    { fichier: "128x128.png", taille: 128 },
    { fichier: "256x256.png", taille: 256 },
    { fichier: "512x512.png", taille: 512 },
  ];

  for (const { fichier, taille } of attendues) {
    it(`${fichier} est RGBA et fait ${String(taille)} pixels`, () => {
      const { colorType, width, height } = pngColorType(join(ICONS_DIR, fichier));
      // 6 = RGBA. Tauri refuse tout le reste, et le dit au moment le plus tardif
      // et le plus coûteux de la construction.
      expect(colorType, "type de couleur PNG").toBe(6);
      expect(width).toBe(taille);
      expect(height).toBe(taille);
    });
  }

  it("icon.png est RGBA", () => {
    expect(pngColorType(join(ICONS_DIR, "icon.png")).colorType).toBe(6);
  });
});
