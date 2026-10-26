export interface EnrichmentFinding {
  provider: "virustotal" | "shodan";
  query: string;
  summary: string;
  raw: unknown;
}
async function requestJson(
  url: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const response = await fetchFn(url, { headers });
  if (!response.ok) throw new Error(`Enrichment provider failed (${response.status}).`);
  return response.json();
}
export async function queryVirusTotal(
  domain: string,
  apiKey: string,
  fetchFn = fetch,
): Promise<EnrichmentFinding> {
  const safe = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(safe)) throw new Error("Invalid public domain.");
  const raw = await requestJson(
    `https://www.virustotal.com/api/v3/domains/${encodeURIComponent(safe)}`,
    { "x-apikey": apiKey },
    fetchFn,
  );
  return {
    provider: "virustotal",
    query: safe,
    summary: "VirusTotal public-domain enrichment completed.",
    raw,
  };
}
export async function queryShodan(
  ip: string,
  apiKey: string,
  fetchFn = fetch,
): Promise<EnrichmentFinding> {
  if (!/^[0-9a-f:.]+$/i.test(ip)) throw new Error("Invalid public IP address.");
  const raw = await requestJson(
    `https://api.shodan.io/shodan/host/${encodeURIComponent(ip)}?key=${encodeURIComponent(apiKey)}`,
    {},
    fetchFn,
  );
  return {
    provider: "shodan",
    query: ip,
    summary: "Shodan public-host enrichment completed.",
    raw,
  };
}
