import { describe, expect, it } from "vitest";
import { generateQrMatrix, generateQrSvg } from "../src/qr.js";

describe("QR Code generator", () => {
  it("generates valid matrix for short text", () => {
    const matrix = generateQrMatrix("test", "L");
    expect(matrix.length).toBe(21); // Version 1 is 21x21
    expect(matrix[0]!.length).toBe(21);

    // Verify top-left finder pattern: 7x7 dark border and center
    expect(matrix[0]![0]).toBe(true);
    expect(matrix[0]![6]).toBe(true);
    expect(matrix[6]![0]).toBe(true);
    expect(matrix[6]![6]).toBe(true);
    expect(matrix[1]![1]).toBe(false);
    expect(matrix[3]![3]).toBe(true);
  });

  it("generates valid matrix for standard pairing payload", () => {
    const payload = "nexus://pair?api=http://127.0.0.1:3000&token=0123456789abcdef0123456789abcdef";
    const matrix = generateQrMatrix(payload, "L");

    // Length 73 in byte mode requires Version 4 or 5
    expect(matrix.length).toBeGreaterThanOrEqual(33);
    expect(matrix.length).toBeLessThanOrEqual(45);

    // Verify top-right and bottom-left finder patterns
    const size = matrix.length;
    expect(matrix[0]![size - 1]).toBe(true);
    expect(matrix[size - 1]![0]).toBe(true);
  });

  it("renders valid SVG markup with viewBox and path data", () => {
    const svg = generateQrSvg("nexus://pair?api=http://localhost:3000&token=test-token", {
      size: 200,
      margin: 4,
    });

    expect(svg).toContain("<svg");
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0');
    expect(svg).toContain('width="200"');
    expect(svg).toContain("<path");
    expect(svg).toContain("</svg>");
  });

  it("throws for payload exceeding max supported capacity", () => {
    const huge = "A".repeat(500);
    expect(() => generateQrMatrix(huge)).toThrow("Text too long");
  });
});
