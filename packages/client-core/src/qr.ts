/**
 * Lightweight, zero-dependency QR code Model 2 generator for pairing payloads.
 *
 * Implements ISO/IEC 18004 Byte mode (8-bit) with Reed-Solomon error correction
 * (Level L & Level M), supporting versions 1 through 10.
 *
 * Produces clean SVG strings and 2D boolean matrices without DOM dependencies,
 * safe for use in Node.js, browser dashboard, desktop, and mobile companion.
 */

// ── Galois Field GF(256) Tables ──────────────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
let x = 1;
for (let i = 0; i < 255; i++) {
  EXP[i] = x;
  EXP[i + 255] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a]! + LOG[b]!) % 255]!;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ gfMul(poly[j]!, EXP[i]!);
      next[j + 1] = (next[j + 1] ?? 0) ^ poly[j]!;
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(data: Uint8Array, numEcBytes: number): Uint8Array {
  const gen = rsGeneratorPoly(numEcBytes);
  const remainder = new Uint8Array(numEcBytes);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[numEcBytes - 1] = 0;
    for (let i = 0; i < numEcBytes; i++) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMul(gen[i]!, factor);
    }
  }
  return remainder;
}

// ── Version Capacity & Layout Table ──────────────────────────────────────────
interface VersionInfo {
  version: number;
  dataBytesL: number;
  ecBytesL: number;
  numBlocksL: number;
  dataBytesM: number;
  ecBytesM: number;
  numBlocksM: number;
  alignment: number[];
}

const VERSIONS: VersionInfo[] = [
  { version: 1, dataBytesL: 19, ecBytesL: 7, numBlocksL: 1, dataBytesM: 16, ecBytesM: 10, numBlocksM: 1, alignment: [] },
  { version: 2, dataBytesL: 34, ecBytesL: 10, numBlocksL: 1, dataBytesM: 28, ecBytesM: 16, numBlocksM: 1, alignment: [6, 18] },
  { version: 3, dataBytesL: 55, ecBytesL: 15, numBlocksL: 1, dataBytesM: 44, ecBytesM: 26, numBlocksM: 1, alignment: [6, 22] },
  { version: 4, dataBytesL: 80, ecBytesL: 20, numBlocksL: 1, dataBytesM: 64, ecBytesM: 18, numBlocksM: 2, alignment: [6, 26] },
  { version: 5, dataBytesL: 108, ecBytesL: 26, numBlocksL: 1, dataBytesM: 86, ecBytesM: 24, numBlocksM: 2, alignment: [6, 30] },
  { version: 6, dataBytesL: 136, ecBytesL: 18, numBlocksL: 2, dataBytesM: 108, ecBytesM: 16, numBlocksM: 4, alignment: [6, 34] },
  { version: 7, dataBytesL: 156, ecBytesL: 20, numBlocksL: 2, dataBytesM: 124, ecBytesM: 18, numBlocksM: 4, alignment: [6, 22, 38] },
  { version: 8, dataBytesL: 194, ecBytesL: 24, numBlocksL: 2, dataBytesM: 154, ecBytesM: 22, numBlocksM: 4, alignment: [6, 24, 42] },
  { version: 9, dataBytesL: 232, ecBytesL: 30, numBlocksL: 2, dataBytesM: 182, ecBytesM: 22, numBlocksM: 4, alignment: [6, 26, 46] },
  { version: 10, dataBytesL: 274, ecBytesL: 18, numBlocksL: 4, dataBytesM: 216, ecBytesM: 26, numBlocksM: 5, alignment: [6, 28, 50] },
];

export interface QrOptions {
  ecc?: "L" | "M";
  margin?: number;
  size?: number;
}

/**
 * Encodes text into a QR Code boolean matrix [row][col] where true = dark module.
 */
export function generateQrMatrix(text: string, ecc: "L" | "M" = "L"): boolean[][] {
  const data = new TextEncoder().encode(text);
  const dataLength = data.length;

  // Determine minimum version
  const vInfo = VERSIONS.find((v) => {
    const maxData = ecc === "L" ? v.dataBytesL : v.dataBytesM;
    // 4 bits mode + 8 bits length (v1-9) + data = dataLength + 2 bytes
    return maxData >= dataLength + 3;
  });

  if (!vInfo) {
    throw new Error(`Text too long for QR code pairing payload (length: ${dataLength})`);
  }

  const numDataBytes = ecc === "L" ? vInfo.dataBytesL : vInfo.dataBytesM;
  const numEcBytes = ecc === "L" ? vInfo.ecBytesL : vInfo.ecBytesM;
  const numBlocks = ecc === "L" ? vInfo.numBlocksL : vInfo.numBlocksM;

  // Build bitstream: Mode (0100) + Char Count (8 bits for v <= 9, 16 for v10) + bytes
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  // Byte mode indicator
  pushBits(0b0100, 4);
  pushBits(dataLength, vInfo.version <= 9 ? 8 : 16);
  for (const b of data) pushBits(b, 8);

  // Terminator (up to 4 zeroes)
  const remainingBits = numDataBytes * 8 - bits.length;
  pushBits(0, Math.min(4, Math.max(0, remainingBits)));

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Pad with alternating 0xEC, 0x11
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < numDataBytes * 8) {
    pushBits(padBytes[padIdx % 2]!, 8);
    padIdx++;
  }

  // Convert bits to data bytes
  const allData = new Uint8Array(numDataBytes);
  for (let i = 0; i < numDataBytes; i++) {
    let byteVal = 0;
    for (let j = 0; j < 8; j++) byteVal = (byteVal << 1) | bits[i * 8 + j]!;
    allData[i] = byteVal;
  }

  // Block splitting and Reed-Solomon calculation
  const ecPerBlock = Math.floor(numEcBytes / numBlocks);
  const dataPerBlock = Math.floor(numDataBytes / numBlocks);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];

  let dataOffset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const curDataLen = dataPerBlock + (b >= numBlocks - (numDataBytes % numBlocks) ? 1 : 0);
    const blockData = allData.slice(dataOffset, dataOffset + curDataLen);
    dataBlocks.push(blockData);
    ecBlocks.push(rsComputeRemainder(blockData, ecPerBlock));
    dataOffset += curDataLen;
  }

  // Interleave data and EC bytes
  const finalSequence: number[] = [];
  const maxBlockLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxBlockLen; i++) {
    for (const b of dataBlocks) {
      if (i < b.length) finalSequence.push(b[i]!);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of ecBlocks) {
      if (i < b.length) finalSequence.push(b[i]!);
    }
  }

  // Matrix construction
  const size = 17 + 4 * vInfo.version;
  const matrix: (boolean | null)[][] = [];
  for (let r = 0; r < size; r++) {
    const row: (boolean | null)[] = [];
    for (let c = 0; c < size; c++) {
      row.push(null);
    }
    matrix.push(row);
  }

  // 1. Finder patterns (7x7) + separators
  const placeFinder = (r: number, c: number) => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const row = r + y;
        const col = c + x;
        if (row >= 0 && row < size && col >= 0 && col < size) {
          if (y >= 0 && y <= 6 && x >= 0 && x <= 6) {
            const isDark = y === 0 || y === 6 || x === 0 || x === 6 || (y >= 2 && y <= 4 && x >= 2 && x <= 4);
            matrix[row]![col] = isDark;
          } else {
            matrix[row]![col] = false;
          }
        }
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // 2. Alignment patterns
  if (vInfo.alignment.length > 0) {
    for (const r of vInfo.alignment) {
      for (const c of vInfo.alignment) {
        if (matrix[r]![c] !== null) continue; // Skip corners with finders
        for (let y = -2; y <= 2; y++) {
          for (let x = -2; x <= 2; x++) {
            const isDark = Math.abs(y) === 2 || Math.abs(x) === 2 || (y === 0 && x === 0);
            matrix[r + y]![c + x] = isDark;
          }
        }
      }
    }
  }

  // 3. Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6]![i] === null) matrix[6]![i] = i % 2 === 0;
    if (matrix[i]![6] === null) matrix[i]![6] = i % 2 === 0;
  }

  // Dark module
  matrix[size - 8]![8] = true;

  // Reserve format areas
  const reserveFormat = (r: number, c: number) => {
    if (matrix[r]![c] === null) matrix[r]![c] = false;
  };
  for (let i = 0; i < 9; i++) {
    reserveFormat(8, i);
    reserveFormat(i, 8);
  }
  for (let i = size - 8; i < size; i++) {
    reserveFormat(8, i);
    reserveFormat(i, 8);
  }

  // 4. Data placement (zigzag)
  let bitIndex = 0;
  const totalBits = finalSequence.length * 8;
  const getNextBit = (): boolean => {
    if (bitIndex >= totalBits) return false;
    const byte = finalSequence[Math.floor(bitIndex / 8)]!;
    const bit = ((byte >> (7 - (bitIndex % 8))) & 1) === 1;
    bitIndex++;
    return bit;
  };

  let upwards = true;
  for (let rightCol = size - 1; rightCol > 0; rightCol -= 2) {
    if (rightCol === 6) rightCol--; // Skip vertical timing column
    const rows = upwards
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const r of rows) {
      for (const c of [rightCol, rightCol - 1]) {
        if (matrix[r]![c] === null) {
          const bit = getNextBit();
          // Apply Mask 0: (row + col) % 2 === 0
          const mask = (r + c) % 2 === 0;
          matrix[r]![c] = mask ? !bit : bit;
        }
      }
    }
    upwards = !upwards;
  }

  // 5. Format information (ECC Level L = 01, Mask 0 = 000 -> 01000)
  // Precomputed format bits with BCH error correction and XOR mask 0x5412:
  // Level L + Mask 0 = 0x77c4 (0b111011111000100)
  // Level M + Mask 0 = 0x5412 (0b101010000010010)
  const formatInfo = ecc === "L" ? 0x77c4 : 0x5412;
  const formatBits: boolean[] = [];
  for (let i = 14; i >= 0; i--) formatBits.push(((formatInfo >> i) & 1) === 1);

  // Place format information
  const formatCoordsTopLeft: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = formatCoordsTopLeft[i]!;
    matrix[r]![c] = formatBits[i]!;
  }

  const formatCoordsSplit: [number, number][] = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = formatCoordsSplit[i]!;
    matrix[r]![c] = formatBits[i]!;
  }

  return matrix.map((row) => row.map((cell) => cell ?? false));
}

/**
 * Generates an SVG string representing the QR code for `text`.
 */
export function generateQrSvg(text: string, options: QrOptions = {}): string {
  const ecc = options.ecc ?? "L";
  const margin = options.margin ?? 4;
  const matrix = generateQrMatrix(text, ecc);
  const modules = matrix.length;
  const totalSize = modules + margin * 2;

  let pathData = "";
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (matrix[r]![c]) {
        pathData += `M${c + margin},${r + margin}h1v1h-1z `;
      }
    }
  }

  const pixelSize = options.size ?? 240;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" aria-label="QR Code for pairing">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <path d="${pathData.trim()}" fill="#000000"/>
</svg>`;
}
