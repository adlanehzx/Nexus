import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Package icons must be **RGBA**.
 *
 * Verifies PNG headers manually to ensure Tauri's `generate_context!` macro
 * does not fail during Rust build with "icon is not RGBA".
 */

const ICONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src-tauri", "icons");

/** PNG color type: 6 = RGBA, 2 = RGB, 3 = indexed, 0 = grayscale. */
function pngColorType(path: string): { colorType: number; width: number; height: number } {
  const header = readFileSync(path).subarray(0, 26);
  const signature = header.subarray(0, 8);
  expect([...signature], `${path}: PNG signature`).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return {
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
    colorType: header.readUInt8(25),
  };
}

describe("package icons", () => {
  const expected = [
    { file: "32x32.png", size: 32 },
    { file: "128x128.png", size: 128 },
    { file: "256x256.png", size: 256 },
    { file: "512x512.png", size: 512 },
  ];

  for (const { file, size } of expected) {
    it(`${file} is RGBA and ${String(size)} pixels wide`, () => {
      const { colorType, width, height } = pngColorType(join(ICONS_DIR, file));
      expect(colorType, "PNG color type").toBe(6);
      expect(width).toBe(size);
      expect(height).toBe(size);
    });
  }

  it("icon.png is RGBA", () => {
    expect(pngColorType(join(ICONS_DIR, "icon.png")).colorType).toBe(6);
  });
});
