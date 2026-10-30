import { useState } from "react";
import type { CareerEducationSettings, LocationType } from "@nexus/client-core";
import { useI18n } from "../i18n/index.js";

interface CareerSettingsProps {
  settings: CareerEducationSettings;
  onUpdateSettings: (updated: Partial<CareerEducationSettings>) => Promise<void>;
  loading?: boolean;
}

export function CareerSettings({
  settings,
  onUpdateSettings,
  loading = false,
}: CareerSettingsProps) {
  const { tr } = useI18n();
  const [formData, setFormData] = useState<CareerEducationSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await onUpdateSettings(formData);
      setNotice(
        tr(
          "Career engine settings saved successfully.",
          "Paramètres du moteur de carrière enregistrés avec succès.",
        ),
      );
    } catch (err) {
      setNotice(
        err instanceof Error
          ? err.message
          : tr("Failed to save settings.", "Échec de l'enregistrement des paramètres."),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="career-tab-content"
      role="region"
      aria-label={tr("Career & Education Settings", "Paramètres Carrière & Formation")}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>
            {tr(
              "Career Engine & Source Settings",
              "Paramètres du Moteur de Carrière & des Sources",
            )}
          </h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            {tr(
              "Configure discovery filters, rate expectations, blacklists, quiet hours, data retention, and error degradation simulations.",
              "Configurez les filtres de découverte, les rémunérations cibles, les listes d'exclusion, les heures silencieuses, la rétention et les simulations d'erreur.",
            )}
          </p>
        </div>

        <button
          type="button"
          className="button primary"
          disabled={saving || loading}
          onClick={() => void handleSave()}
        >
          {saving
            ? tr("Saving...", "Enregistrement...")
            : tr("Save Settings", "Enregistrer les paramètres")}
        </button>
      </div>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "0.65rem 1rem",
            borderRadius: "var(--radius)",
            background: "var(--nx-ok-bg)",
            color: "var(--ok)",
            fontSize: "0.85rem",
          }}
        >
          {notice}
        </div>
      )}

      {/* Safety & Simulation Modes */}
      <div
        className="career-card"
        style={{ borderLeft: "4px solid var(--accent)", gap: "0.75rem" }}
      >
        <strong>
          {tr(
            "Simulated State Controls (Honest Error Verification)",
            "Contrôles d'états simulés (Vérification honnête des erreurs)",
          )}
        </strong>
        <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted-text)" }}>
          {tr(
            "Test that the UX displays honest unavailable and degraded states rather than fake or silent success.",
            "Vérifiez que l'interface affiche fidèlement les indisponibilités et les états dégradés plutôt qu'un faux succès silencieux.",
          )}
        </p>

        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            <input
              type="checkbox"
              checked={formData.offlineSimulation}
              onChange={(e) => setFormData({ ...formData, offlineSimulation: e.target.checked })}
            />
            <span>
              <strong>{tr("Simulate Network Offline", "Simuler réseau hors ligne")}</strong> (
              {tr(
                "Forces feeds to throw NetworkOfflineError",
                "Force les flux à lever NetworkOfflineError",
              )}
              )
            </span>
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            <input
              type="checkbox"
              checked={formData.degradedFeedSimulation}
              onChange={(e) =>
                setFormData({ ...formData, degradedFeedSimulation: e.target.checked })
              }
            />
            <span>
              <strong>{tr("Simulate Degraded Feeds", "Simuler flux dégradés")}</strong> (
              {tr(
                "Shows HTTP 429 rate limit backoff alerts",
                "Affiche les alertes de limitation HTTP 429",
              )}
              )
            </span>
          </label>
        </div>
      </div>

      {/* Settings Grid */}
      <div className="career-grid-2">
        {/* Locations & Remote */}
        <div className="career-card" style={{ gap: "0.75rem" }}>
          <strong>
            {tr("Location & Remote Preferences", "Préférences de localisation & télétravail")}
          </strong>
          <div className="career-form-group">
            <label htmlFor="settingsRemote">
              {tr("Remote Work Policy", "Politique de télétravail")}
            </label>
            <select
              id="settingsRemote"
              className="career-select"
              value={formData.remotePolicy}
              onChange={(e) =>
                setFormData({ ...formData, remotePolicy: e.target.value as LocationType })
              }
            >
              <option value="remote">
                {tr("100% Remote Only", "100% Télétravail uniquement")}
              </option>
              <option value="hybrid">
                {tr(
                  "Hybrid (Periodic Onsite / Coworking)",
                  "Hybride (Présentiel périodique / Coworking)",
                )}
              </option>
              <option value="onsite">{tr("Onsite", "Sur site uniquement")}</option>
            </select>
          </div>

          <div className="career-form-group">
            <label htmlFor="settingsLocations">
              {tr("Allowed Cities / Regions", "Villes / Régions autorisées")}
            </label>
            <input
              id="settingsLocations"
              className="career-input"
              type="text"
              value={formData.preferredLocations.join(", ")}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  preferredLocations: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
        </div>

        {/* Disciplines & Keywords */}
        <div className="career-card" style={{ gap: "0.75rem" }}>
          <strong>
            {tr("Disciplines & Search Keywords", "Disciplines & Mots-clés de recherche")}
          </strong>
          <div className="career-form-group">
            <label htmlFor="settingsKeywords">
              {tr("Keywords (comma separated)", "Mots-clés (séparés par des virgules)")}
            </label>
            <input
              id="settingsKeywords"
              className="career-input"
              type="text"
              value={formData.disciplinesAndKeywords.join(", ")}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  disciplinesAndKeywords: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <div className="career-form-group">
            <label htmlFor="settingsVisa">
              {tr(
                "Visa & Work Authorization Requirement",
                "Exigence de visa & autorisation de travail",
              )}
            </label>
            <input
              id="settingsVisa"
              className="career-input"
              type="text"
              value={formData.visaRequirement}
              onChange={(e) => setFormData({ ...formData, visaRequirement: e.target.value })}
            />
          </div>
        </div>

        {/* Rates & Compensation Thresholds */}
        <div className="career-card" style={{ gap: "0.75rem" }}>
          <strong>{tr("Compensation & Rate Thresholds", "Seuils de rémunération & TJM")}</strong>
          <div className="career-grid-3">
            <div className="career-form-group">
              <label htmlFor="setMinCdi">
                {tr("Minimum Annual Salary (€)", "Salaire annuel minimum (€)")}
              </label>
              <input
                id="setMinCdi"
                className="career-input"
                type="number"
                value={formData.minAnnualSalaryCdi ?? 0}
                onChange={(e) =>
                  setFormData({ ...formData, minAnnualSalaryCdi: Number(e.target.value) })
                }
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="setMinTjm">
                {tr("Minimum Independent Daily Rate (€)", "TJM minimum indépendant (€)")}
              </label>
              <input
                id="setMinTjm"
                className="career-input"
                type="number"
                value={formData.minDailyRateTjmFreelance ?? 0}
                onChange={(e) =>
                  setFormData({ ...formData, minDailyRateTjmFreelance: Number(e.target.value) })
                }
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="setMinStipend">
                {tr("Min PhD Stipend (€/mo)", "Allocation doctorale min (€/mois)")}
              </label>
              <input
                id="setMinStipend"
                className="career-input"
                type="number"
                value={formData.minMonthlyStipendPhd ?? 0}
                onChange={(e) =>
                  setFormData({ ...formData, minMonthlyStipendPhd: Number(e.target.value) })
                }
              />
            </div>
          </div>
        </div>

        {/* Blacklists & Excluded Sources */}
        <div className="career-card" style={{ gap: "0.75rem" }}>
          <strong>
            {tr(
              "Excluded Sources & Organizations (Blacklists)",
              "Sources & Organisations exclues (Listes noires)",
            )}
          </strong>
          <div className="career-form-group">
            <label htmlFor="setExcludedSources">
              {tr(
                "Excluded Domains / Feeds (comma separated)",
                "Domaines / Flux exclus (séparés par des virgules)",
              )}
            </label>
            <input
              id="setExcludedSources"
              className="career-input"
              type="text"
              value={formData.excludedSources.join(", ")}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  excludedSources: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <div className="career-form-group">
            <label htmlFor="setExcludedOrgs">
              {tr(
                "Excluded Organizations (comma separated)",
                "Organisations exclues (séparées par des virgules)",
              )}
            </label>
            <input
              id="setExcludedOrgs"
              className="career-input"
              type="text"
              value={formData.excludedOrganizations.join(", ")}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  excludedOrganizations: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
        </div>

        {/* Quiet Hours & Alerts */}
        <div className="career-card" style={{ gap: "0.75rem" }}>
          <strong>
            {tr("Quiet Hours & Notification Policy", "Heures silencieuses & Politique d'alerte")}
          </strong>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={formData.quietHours.enabled}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  quietHours: { ...formData.quietHours, enabled: e.target.checked },
                })
              }
            />
            {tr(
              "Enable Quiet Hours (Suppresses non-urgent opportunity alerts)",
              "Activer les heures silencieuses (Bloque les alertes non urgentes)",
            )}
          </label>
          <div className="career-grid-3">
            <div className="career-form-group">
              <label htmlFor="qhStart">{tr("Start (HH:MM)", "Début (HH:MM)")}</label>
              <input
                id="qhStart"
                className="career-input"
                type="text"
                value={formData.quietHours.start}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    quietHours: { ...formData.quietHours, start: e.target.value },
                  })
                }
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="qhEnd">{tr("End (HH:MM)", "Fin (HH:MM)")}</label>
              <input
                id="qhEnd"
                className="career-input"
                type="text"
                value={formData.quietHours.end}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    quietHours: { ...formData.quietHours, end: e.target.value },
                  })
                }
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="qhTz">{tr("Timezone", "Fuseau horaire")}</label>
              <input
                id="qhTz"
                className="career-input"
                type="text"
                value={formData.quietHours.timezone}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    quietHours: { ...formData.quietHours, timezone: e.target.value },
                  })
                }
              />
            </div>
          </div>
        </div>

        {/* Data Retention */}
        <div className="career-card" style={{ gap: "0.75rem" }}>
          <strong>
            {tr("Data Retention & Privacy", "Rétention des données & Confidentialité")}
          </strong>
          <div className="career-form-group">
            <label htmlFor="retentionDays">
              {tr(
                "Application & Audit Retention (Days)",
                "Rétention des candidatures & audits (Jours)",
              )}
            </label>
            <input
              id="retentionDays"
              className="career-input"
              type="number"
              min={30}
              max={730}
              value={formData.retentionDays}
              onChange={(e) => setFormData({ ...formData, retentionDays: Number(e.target.value) })}
            />
          </div>
          <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted-text)" }}>
            {tr(
              "Automatically purges historical drafts, browser screenshots, and temporary traces after the retention window.",
              "Purge automatiquement les brouillons historiques, captures de navigateur et traces temporaires après la période de rétention.",
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
