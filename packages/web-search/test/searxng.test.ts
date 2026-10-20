import { describe, expect, it, vi } from "vitest";
import { SearxngClient, createWebSearchTools } from "../src/index.js";

describe("SearxngClient", () => {
  it("normalise et borne les résultats sans exposer les URLs dangereuses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          query: "nexus",
          number_of_results: 42,
          suggestions: ["agents", "agents"],
          answers: ["Une réponse"],
          results: [
            {
              title: " Source officielle ",
              url: "https://example.org/article",
              content: " Résumé ",
              engines: ["duckduckgo", "duckduckgo"],
              publishedDate: null,
              score: 1.5,
            },
            { title: "Interdit", url: "file:///etc/passwd", content: "non" },
            { title: "Sans URL" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new SearxngClient({ baseUrl: "http://127.0.0.1:8080", fetch });

    const response = await client.search({ query: "nexus", limit: 5 });

    expect(response.results).toEqual([
      {
        title: "Source officielle",
        url: "https://example.org/article",
        snippet: "Résumé",
        engines: ["duckduckgo"],
        publishedAt: null,
        score: 1.5,
      },
    ]);
    expect(response.suggestions).toEqual(["agents"]);
    expect(response.numberOfResults).toBe(42);
    const request = fetch.mock.calls[0];
    const target = request?.[0];
    expect(target).toBeInstanceOf(URL);
    expect(target instanceof URL ? target.toString() : "").toBe("http://127.0.0.1:8080/search");
    expect(request?.[1]?.method).toBe("POST");
  });

  it("refuse les credentials et le HTTP distant", () => {
    expect(() => new SearxngClient({ baseUrl: "http://user:secret@localhost:8080" })).toThrow(
      /credentials/,
    );
    expect(() => new SearxngClient({ baseUrl: "http://example.org" })).toThrow(/HTTPS/);
  });

  it("expose un outil SAFE, idempotent et protégé par la permission navigateur", () => {
    const provider = { search: vi.fn() };
    const [tool, fetchTool] = createWebSearchTools({ provider });
    expect(tool?.name).toBe("search.web");
    expect(tool?.riskLevel).toBe("SAFE");
    expect(tool?.idempotent).toBe(true);
    expect(tool?.requiredPermissions).toEqual(["browser.navigate"]);
    expect(fetchTool?.name).toBe("web.fetch");
    expect(fetchTool?.riskLevel).toBe("SAFE");
    expect(fetchTool?.requiredPermissions).toEqual(["browser.navigate"]);
  });
});
