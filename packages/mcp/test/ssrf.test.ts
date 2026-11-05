import { describe, expect, it, vi } from "vitest";
import {
  assertSafeRemoteUrl,
  createSafeMcpFetch,
  isPrivateOrReservedIp,
  parseIpv4ToNumber,
} from "../src/ssrf.js";
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

  it("rejects alternative IP representations including octal, DWORD integer, hex and IPv4-mapped IPv6", () => {
    // Octal representation (0177.0.0.1 -> 127.0.0.1)
    expect(isPrivateOrReservedIp("0177.0.0.1")).toBe(true);
    expect(parseIpv4ToNumber("0177.0.0.1")).toBe(2130706433);

    // 32-bit integer DWORD (2130706433 -> 127.0.0.1)
    expect(isPrivateOrReservedIp("2130706433")).toBe(true);
    expect(parseIpv4ToNumber("2130706433")).toBe(2130706433);

    // Hexadecimal representation (0x7f.0.0.1 or 0x7f000001 -> 127.0.0.1)
    expect(isPrivateOrReservedIp("0x7f.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("0x7f000001")).toBe(true);

    // IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:169.254.169.254, ::ffff:7f00:1)
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:7f00:1")).toBe(true);

    // Non-private addresses return false
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
  });

  it("rejects HTTP redirects to private or cloud metadata IPs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).includes("redirector")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const safeFetch = createSafeMcpFetch({
      serverName: "test-server",
      fetchFn: fetchMock,
      skipDnsResolution: true,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    } as unknown as import("../src/ssrf.js").SafeMcpFetchOptions);

    await expect(safeFetch("http://redirector.example.com/start")).rejects.toThrow(
      McpSecurityError,
    );
    // Request must NEVER have been made to the private metadata destination
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("169.254.169.254"),
      expect.anything(),
    );
  });

  it("simulates and blocks DNS rebinding attack (first resolution public, subsequent private)", async () => {
    let callCount = 0;
    // Attacker DNS server: first answer is benign public IP, second answer is localhost
    const rebindLookup = async () => {
      callCount++;
      if (callCount === 1) {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "127.0.0.1", family: 4 }];
    };

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      return new Response("ok", { status: 200 });
    });

    const safeFetch = createSafeMcpFetch({
      serverName: "rebind-test",
      fetchFn: fetchMock,
      dnsLookup: rebindLookup,
    });

    // First request succeeds when resolving to public IP
    const res1 = await safeFetch("http://rebind.attacker.com/data");
    expect(res1.status).toBe(200);

    // Second request detects rebinding to private 127.0.0.1 and aborts with McpSecurityError
    await expect(safeFetch("http://rebind.attacker.com/data")).rejects.toThrow(McpSecurityError);
  });

  it("preserves normal operation for legitimate remote MCP servers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      return new Response(JSON.stringify({ result: "mcp-ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const safeFetch = createSafeMcpFetch({
      serverName: "prod-server",
      fetchFn: fetchMock,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    const res = await safeFetch("https://api.github.com/mcp/sse");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ result: "mcp-ready" });
  });
});
