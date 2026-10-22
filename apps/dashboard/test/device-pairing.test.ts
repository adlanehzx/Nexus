import { describe, expect, it } from "vitest";
import { generateQrSvg } from "@nexus/client-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Device discovery and pairing security (G3)", () => {
  it("generates valid SVG QR code for pairing payloads", () => {
    const payload = "nexus://pair?api=https%3A%2F%2Fnexus.example.com&token=test-token-1234567890";
    const svg = generateQrSvg(payload);

    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<rect");
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
  });

  it("ensures Windows setup script never requires secrets on command line", () => {
    const psScript = readFileSync(
      resolve(__dirname, "../../../packaging/windows/setup-worker.ps1"),
      "utf8",
    );

    // Verifies support for -TokenStdin and stdin streaming
    expect(psScript).toContain("TokenStdin");
    expect(psScript).toContain("$pairEntry");
    expect(psScript).toContain("--token-stdin");
    // English comments and messages
    expect(psScript).not.toContain("Appaire, configure et installe");
    expect(psScript).not.toContain("ou plus recent");
  });

  it("ensures Linux installer script supports stdin and warns against argv tokens", () => {
    const shScript = readFileSync(
      resolve(__dirname, "../../../packaging/linux/install-worker.sh"),
      "utf8",
    );

    expect(shScript).toContain("--token-stdin");
    expect(shScript).toContain("docker run");
    expect(shScript).toContain("--user");
    expect(shScript).toContain("--cap-drop ALL");
  });

  it("ensures dashboard pairing commands stream tokens via stdin", () => {
    const sectionsCode = readFileSync(resolve(__dirname, "../src/ui/Sections.tsx"), "utf8");

    // Linux command must pipe token via stdin, not pass as argv
    expect(sectionsCode).toContain("printf '%s' '${pairing.token}' | ./install-worker.sh");
    // Windows command must pipe token via stdin with -TokenStdin
    expect(sectionsCode).toContain("-TokenStdin");
    // Must render QR code
    expect(sectionsCode).toContain("generateQrSvg(pairing.payload)");
    // Disconnect and capabilities management
    expect(sectionsCode).toContain("api.disconnectDevice");
    expect(sectionsCode).toContain("api.updateDeviceCapabilities");
  });
});
