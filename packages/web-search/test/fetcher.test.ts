import { describe, expect, it, vi } from "vitest";
import { SafeWebFetcher, assertPublicWebUrl, isPublicIp } from "../src/index.js";

const publicResolver = () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]);

describe("politique réseau", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("bloque l'adresse privée %s", (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each(["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepte l'adresse publique %s",
    (address) => {
      expect(isPublicIp(address)).toBe(true);
    },
  );

  it("refuse localhost, les credentials, les ports privés et une résolution mixte", async () => {
    await expect(assertPublicWebUrl("http://localhost/test", publicResolver)).rejects.toThrow(
      /privée/,
    );
    await expect(assertPublicWebUrl("https://u:p@example.org", publicResolver)).rejects.toThrow(
      /identifiants/,
    );
    await expect(assertPublicWebUrl("https://example.org:8443", publicResolver)).rejects.toThrow(
      /ports web/,
    );
    await expect(
      assertPublicWebUrl("https://example.org", () =>
        Promise.resolve([
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]),
      ),
    ).rejects.toThrow(/privée/);
  });
});

describe("SafeWebFetcher", () => {
  it("suit une redirection validée, extrait le texte et conserve la provenance", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/article" } }))
      .mockResolvedValueOnce(
        new Response(
          `<!doctype html><html lang="fr"><head>
            <title>NEXUS &amp; recherche</title>
            <meta name="description" content="Une description fiable">
            <meta name="author" content="Ada">
            <meta property="article:published_time" content="2026-10-20">
            <link rel="canonical" href="/article?utm_source=test">
          </head><body><script>ignore me</script>
          <h1>Résultat</h1><p>Le contenu public est extrait sans exécuter le script.</p>
          </body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      );
    const client = new SafeWebFetcher({
      fetch,
      resolver: publicResolver,
      now: () => new Date("2026-10-20T12:00:00.000Z"),
    });

    const document = await client.fetch({ url: "https://example.org/start" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(document.finalUrl).toBe("https://example.org/article");
    expect(document.canonicalUrl).toBe("https://example.org/article?utm_source=test");
    expect(document.provenance).toEqual({
      redirectChain: ["https://example.org/start"],
      untrustedExternalContent: true,
    });
    expect(document.metadata).toMatchObject({
      title: "NEXUS & recherche",
      description: "Une description fiable",
      author: "Ada",
      publishedAt: "2026-10-20",
      language: "fr",
    });
    expect(document.content).toContain("Le contenu public est extrait");
    expect(document.content).not.toContain("ignore me");
    expect(document.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("bloque une redirection SSRF avant le second appel réseau", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
      );
    const client = new SafeWebFetcher({ fetch, resolver: publicResolver });

    await expect(client.fetch({ url: "https://example.org" })).rejects.toThrow(/privée/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("borne la réponse même sans Content-Length", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response("x".repeat(2_000), { headers: { "content-type": "text/plain" } }),
      );
    const client = new SafeWebFetcher({ fetch, resolver: publicResolver });

    await expect(
      client.fetch({ url: "https://example.org/large", maxBytes: 1_024 }),
    ).rejects.toThrow(/byte limit/);
  });

  it("refuse les formats binaires", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("%PDF", { headers: { "content-type": "application/pdf" } }));
    const client = new SafeWebFetcher({ fetch, resolver: publicResolver });

    await expect(client.fetch({ url: "https://example.org/file.pdf" })).rejects.toThrow(
      /Unsupported web content type/,
    );
  });
});
