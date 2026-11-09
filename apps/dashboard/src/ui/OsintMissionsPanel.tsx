import { useEffect, useState } from "react";
import type { OsintMission, OsintTarget, OsintCollectorId, OsintMissionInput } from "@nexus/osint";
import type { DashboardApi } from "../lib/api.js";
import { IconPlus } from "./icons.js";

const collectors: OsintCollectorId[] = [
  "search",
  "dns",
  "rdap",
  "crt",
  "username",
  "page",
  "correlation",
];
const categories: OsintMissionInput["config"]["sourceCategories"] = [
  "web",
  "registry",
  "social",
  "technical",
];
export function OsintMissionsPanel({
  api,
  onCase,
}: {
  api: DashboardApi;
  onCase: (id: string) => void;
}) {
  const [missions, setMissions] = useState<OsintMission[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [title, setTitle] = useState("");
  const [targets, setTargets] = useState("");
  const [type, setType] = useState<OsintTarget["type"]>("domain");
  const [depth, setDepth] = useState(1);
  const [iterations, setIterations] = useState(20);
  const [duration, setDuration] = useState(300);
  const [tokens, setTokens] = useState(8000);
  const [enabled, setEnabled] = useState<OsintCollectorId[]>([
    "search",
    "dns",
    "rdap",
    "crt",
    "page",
    "correlation",
  ]);
  const [allowed, setAllowed] = useState(categories);
  const [sites, setSites] = useState(
    "https://github.com/{username}\nhttps://www.reddit.com/user/{username}/",
  );
  const [lawful, setLawful] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = missions.find((m) => m.id === selectedId);
  const refresh = async () => setMissions((await api.osintMissions()).missions);
  useEffect(() => {
    let active = true;
    const poll = () =>
      void api
        .osintMissions()
        .then((r) => {
          if (active) setMissions(r.missions);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="domain-panel osint-panel-stack"
      style={{ color: "var(--nx-text)", borderColor: "var(--nx-line)" }}
    >
      <h3>Nouvelle mission autonome</h3>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            const mission = await api.createOsintMission({
              title,
              targets: targets
                .split("\n")
                .filter((v) => v.trim())
                .map((value) => {
                  const match = /^(person|username|email|domain|organization|ip|phone):(.+)$/.exec(
                    value.trim(),
                  );
                  return {
                    type: match ? (match[1] as OsintTarget["type"]) : type,
                    value: (match ? match[2]! : value).trim(),
                  };
                }),
              lawfulPurposeConfirmed: true,
              config: {
                maxDepth: depth,
                maxIterations: iterations,
                maxDurationSeconds: duration,
                maxLlmTokens: tokens,
                collectors: enabled,
                sourceCategories: allowed,
                usernameSites: sites
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
              },
            });
            setSelectedId(mission.id);
            onCase(mission.caseId);
          });
        }}
      >
        <div className="settings-grid">
          <label>
            Titre
            <input
              required
              minLength={3}
              maxLength={120}
              className="field"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Type de cible par défaut
            <select
              className="field"
              value={type}
              onChange={(e) => setType(e.target.value as OsintTarget["type"])}
            >
              {["person", "username", "email", "domain", "organization", "ip", "phone"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="settings-wide">
            Cibles, une par ligne (préfixe facultatif : email:, domain:, person:...)
            <textarea
              required
              className="field"
              value={targets}
              onChange={(e) => setTargets(e.target.value)}
            />
          </label>
          <label>
            Profondeur
            <input
              className="field"
              type="number"
              min={0}
              max={4}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
            />
          </label>
          <label>
            Itérations
            <input
              className="field"
              type="number"
              min={1}
              max={100}
              value={iterations}
              onChange={(e) => setIterations(Number(e.target.value))}
            />
          </label>
          <label>
            Durée maximale (secondes)
            <input
              className="field"
              type="number"
              min={10}
              max={3600}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </label>
          <label>
            Budget total LLM (tokens)
            <input
              className="field"
              type="number"
              min={256}
              max={100000}
              value={tokens}
              onChange={(e) => setTokens(Number(e.target.value))}
            />
          </label>
        </div>
        <fieldset>
          <legend>Collecteurs</legend>
          {collectors.map((c) => (
            <label key={c} style={{ marginRight: 12 }}>
              <input
                type="checkbox"
                checked={enabled.includes(c)}
                onChange={(e) =>
                  setEnabled(e.target.checked ? [...enabled, c] : enabled.filter((v) => v !== c))
                }
              />{" "}
              {c}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Sources autorisées</legend>
          {categories.map((c) => (
            <label key={c} style={{ marginRight: 12 }}>
              <input
                type="checkbox"
                checked={allowed.includes(c)}
                onChange={(e) =>
                  setAllowed(e.target.checked ? [...allowed, c] : allowed.filter((v) => v !== c))
                }
              />{" "}
              {c}
            </label>
          ))}
        </fieldset>
        <label>
          Sites publics pour les pseudonymes (une URL par ligne, avec {"{username}"})
          <textarea className="field" value={sites} onChange={(e) => setSites(e.target.value)} />
        </label>
        <label>
          <input
            type="checkbox"
            required
            checked={lawful}
            onChange={(e) => setLawful(e.target.checked)}
          />{" "}
          Je confirme la finalité légitime et la collecte de sources publiques.
        </label>
        <button
          className="button primary"
          disabled={busy || !lawful || !enabled.length || !allowed.length}
        >
          <IconPlus size={14} /> Lancer la mission
        </button>
      </form>
      <h4>Missions</h4>
      <div className="settings-actions">
        {missions.map((m) => (
          <button
            type="button"
            className="button"
            key={m.id}
            onClick={() => {
              setSelectedId(m.id);
              onCase(m.caseId);
            }}
            aria-pressed={selectedId === m.id}
          >
            {m.input.title} · {m.status}
          </button>
        ))}
      </div>
      {selected && (
        <>
          <p aria-live="polite">
            {selected.status} · {selected.iterations} itérations · {selected.tokens} tokens ·{" "}
            {selected.frontier.length} cibles en attente
          </p>
          {selected.reason && <p role="status">{selected.reason}</p>}
          <div className="settings-actions">
            {(["pause", "resume", "cancel"] as const).map((action) => (
              <button
                className="button"
                type="button"
                key={action}
                disabled={
                  busy ||
                  (action === "resume"
                    ? selected.status !== "paused"
                    : !["queued", "running", "paused"].includes(selected.status))
                }
                onClick={() =>
                  void act(async () => {
                    await api.controlOsintMission(selected.id, action);
                  })
                }
              >
                {action === "pause" ? "Pause" : action === "resume" ? "Reprendre" : "Annuler"}
              </button>
            ))}
          </div>
          <h4>Journal des agents</h4>
          <ol style={{ maxHeight: 260, overflow: "auto" }}>
            {selected.timeline.map((event, i) => (
              <li key={i}>
                <time>{new Date(event.at).toLocaleTimeString()}</time> ·{" "}
                <strong>{event.action}</strong> · {event.detail}
              </li>
            ))}
          </ol>
          {selected.report && (
            <>
              <h4>Rapport de mission</h4>
              <pre style={{ whiteSpace: "pre-wrap" }}>{selected.report}</pre>
              <button
                className="button"
                type="button"
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([selected.report!], { type: "text/markdown" }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `osint-${selected.id}.md`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Exporter le rapport Markdown
              </button>
            </>
          )}
          <p className="muted">
            Le graphe et les archives du dossier sélectionné se mettent à jour automatiquement
            ci-dessous. Les exports PDF et Markdown du dossier sont disponibles dans Rapports.
          </p>
        </>
      )}
    </section>
  );
}
