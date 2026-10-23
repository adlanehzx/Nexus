import { describe, expect, it } from "vitest";
import { assertSafeRemoteUrl, isPrivateOrReservedIp } from "../src/ssrf.js";
import { McpSecurityError } from "../src/errors.js";

describe("MCP SSRF Policy", () => {
  it("identifies private and reserved IPv4 addresses", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("127.255.255.254")).toBe(true);
    expect(isPrivateOrReservedIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.255.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.31.255.254")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true); // Cloud metadata
    expect(isPrivateOrReservedIp("0.0.0.0")).toBe(true);
    expect(isPrivateOrReservedIp("100.64.0.1")).toBe(true); // CGNAT
    expect(isPrivateOrReservedIp("224.0.0.1")).toBe(true); // Multicast
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false); // Public Google DNS
    expect(isPrivateOrReservedIp("1.1.1.1")).toBe(false); // Public Cloudflare DNS
  });

  it("identifies private and reserved IPv6 addresses", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("::")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true); // Link-local
    expect(isPrivateOrReservedIp("fc00::1")).toBe(true); // Unique local
    expect(isPrivateOrReservedIp("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateOrReservedIp("ff02::1")).toBe(true); // Multicast
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped loopback
    expect(isPrivateOrReservedIp("::ffff:10.0.0.1")).toBe(true); // IPv4-mapped private
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false); // Cloudflare public IPv6
  });

  it("blocks dangerous schemes, loopback, private IPs and cloud metadata", async () => {
    await expect(assertSafeRemoteUrl("ftp://example.com")).rejects.toThrow(McpSecurityError);
    await expect(assertSafeRemoteUrl("file:///etc/passwd")).rejects.toThrow(McpSecurityError);
    await expect(assertSafeRemoteUrl("javascript:alert(1)")).rejects.toThrow(McpSecurityError);

    await expect(assertSafeRemoteUrl("http://localhost:8080")).rejects.toThrow(McpSecurityError);
    await expect(assertSafeRemoteUrl("http://127.0.0.1:3000")).rejects.toThrow(McpSecurityError);
    await expect(assertSafeRemoteUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      McpSecurityError,
    );
    await expect(assertSafeRemoteUrl("http://10.0.0.5/api")).rejects.toThrow(McpSecurityError);
    await expect(assertSafeRemoteUrl("http://192.168.1.1/admin")).rejects.toThrow(McpSecurityError);
    await expect(assertSafeRemoteUrl("http://[::1]:8080")).rejects.toThrow(McpSecurityError);
  });

  it("allows safe public HTTPS URLs", async () => {
    const url = await assertSafeRemoteUrl("https://api.github.com/mcp", {
      skipDnsResolution: true,
    });
    expect(url.hostname).toBe("api.github.com");
    expect(url.protocol).toBe("https:");
  });

  it("allows localhost when explicitly permitted for testing", async () => {
    const url = await assertSafeRemoteUrl("http://localhost:3000/sse", {
      allowLocalhost: true,
    });
    expect(url.hostname).toBe("localhost");
  });
});
