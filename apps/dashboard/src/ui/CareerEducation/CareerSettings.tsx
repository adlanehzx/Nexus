import { useState } from "react";
import type { CareerEducationSettings, LocationType } from "@nexus/client-core";

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
  const [formData, setFormData] = useState<CareerEducationSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await onUpdateSettings(formData);
      setNotice("Career engine settings saved successfully.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="career-edu-container" role="region" aria-label="Career & Education Settings">
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
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>Career Engine & Source Settings</h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            Configure discovery filters, rate expectations, blacklists, quiet hours, data retention,
            and error degradation simulations.
          </p>
        </div>

        <button
          type="button"
          className="button primary"
          disabled={saving || loading}
          onClick={() => void handleSave()}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "0.65rem 1rem",
            borderRadius: "var(--radius)",
            background: "rgb(95 211 154 / 12%)",
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
        <strong>Simulated State Controls (Honest Error Verification)</strong>
        <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted-text)" }}>
          Test that the UX displays honest unavailable and degraded states rather than fake or
          silent success.
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
              <strong>Simulate Network Offline</strong> (Forces feeds to throw NetworkOfflineError)
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
              <strong>Simulate Degraded Feeds</strong> (Shows HTTP 429 rate limit backoff alerts)
            </span>
          </label>
        </div>
      </div>

      {/* Settings Grid */}
      <div className="career-grid-2">
        {/* Locations & Remote */}
        <div className="career-card" style={{ gap: "0.75rem" }}>
          <strong>Location & Remote Preferences</strong>
          <div className="career-form-group">
            <label htmlFor="settingsRemote">Remote Work Policy</label>
            <select
              id="settingsRemote"
              className="career-select"
              value={formData.remotePolicy}
              onChange={(e) =>
                setFormData({ ...formData, remotePolicy: e.target.value as LocationType })
              }
            >
              <option value="remote">100% Remote Only</option>
              <option value="hybrid">Hybrid (Periodic Onsite / Coworking)</option>
              <option value="onsite">Onsite</option>
            </select>
          </div>

          <div className="career-form-group">
            <label htmlFor="settingsLocations">Allowed Cities / Regions</label>
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
          <strong>Disciplines & Search Keywords</strong>
          <div className="career-form-group">
            <label htmlFor="settingsKeywords">Keywords (comma separated)</label>
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
            <label htmlFor="settingsVisa">Visa & Work Authorization Requirement</label>
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
          <strong>Compensation & Rate Thresholds</strong>
          <div className="career-grid-3">
            <div className="career-form-group">
              <label htmlFor="setMinCdi">Minimum Annual Salary (€)</label>
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
              <label htmlFor="setMinTjm">Minimum Independent Daily Rate (€)</label>
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
              <label htmlFor="setMinStipend">Min PhD Stipend (€/mo)</label>
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
          <strong>Excluded Sources & Organizations (Blacklists)</strong>
          <div className="career-form-group">
            <label htmlFor="setExcludedSources">Excluded Domains / Feeds (comma separated)</label>
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
            <label htmlFor="setExcludedOrgs">Excluded Organizations (comma separated)</label>
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
          <strong>Quiet Hours & Notification Policy</strong>
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
            Enable Quiet Hours (Suppresses non-urgent opportunity alerts)
          </label>
          <div className="career-grid-3">
            <div className="career-form-group">
              <label htmlFor="qhStart">Start (HH:MM)</label>
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
              <label htmlFor="qhEnd">End (HH:MM)</label>
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
              <label htmlFor="qhTz">Timezone</label>
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
          <strong>Data Retention & Privacy</strong>
          <div className="career-form-group">
            <label htmlFor="retentionDays">Application & Audit Retention (Days)</label>
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
            Automatically purges historical drafts, browser screenshots, and temporary traces after
            the retention window.
          </p>
        </div>
      </div>
    </div>
  );
}
