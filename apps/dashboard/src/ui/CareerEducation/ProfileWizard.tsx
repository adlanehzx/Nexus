import { useState } from "react";
import type { CareerEducationProfile, OpportunityTrack, LocationType } from "@nexus/client-core";

interface ProfileWizardProps {
  profile: CareerEducationProfile;
  onUpdate: (updated: Partial<CareerEducationProfile>) => Promise<void>;
  loading?: boolean;
}

export function ProfileWizard({ profile, onUpdate, loading = false }: ProfileWizardProps) {
  const [activeStep, setActiveStep] = useState<number>(0);
  const [formData, setFormData] = useState<CareerEducationProfile>(profile);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const steps = [
    { id: "identity", label: "Identity & Goals" },
    { id: "tracks", label: "Career Tracks" },
    { id: "skills", label: "Skills & Discipline" },
    { id: "location", label: "Location & Remote" },
    { id: "compensation", label: "Compensation & Rates" },
    { id: "academic", label: "Academic & PhD" },
    { id: "languages", label: "Languages & Visa" },
    { id: "freelance", label: "Freelance Details" },
  ];

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      await onUpdate(formData);
      setSaveMessage("Profile updated successfully. Completeness score recalculated.");
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : "Failed to update profile.");
    } finally {
      setSaving(false);
    }
  };

  const completeness = profile.completeness;

  return (
    <div className="career-edu-container" role="region" aria-label="Goals and Profile Wizard">
      {/* Completeness Meter */}
      <div className="completeness-gauge-box">
        <div className="completeness-header">
          <div>
            <strong style={{ fontSize: "1.05rem" }}>Profile Completeness</strong>
            <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
              A complete profile enables accurate match scoring and verified recommendations.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <span
              style={{
                fontSize: "1.75rem",
                fontWeight: 800,
                color: completeness.score >= 80 ? "var(--ok)" : "var(--gradient)",
              }}
            >
              {completeness.score}%
            </span>
          </div>
        </div>

        <div
          className="completeness-bar"
          role="progressbar"
          aria-valuenow={completeness.score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Profile completeness score"
        >
          <div className="completeness-bar-fill" style={{ width: `${completeness.score}%` }} />
        </div>

        {/* Breakdown Checklist */}
        <div className="checklist-items">
          {completeness.breakdown.map((item) => (
            <div key={item.id} className={`checklist-item ${item.completed ? "done" : ""}`}>
              <span className="status-icon" aria-hidden="true">
                {item.completed ? "✓" : "○"}
              </span>
              <div>
                <strong>{item.label}</strong>
                {!item.completed && (
                  <div style={{ fontSize: "0.75rem", color: "var(--gradient)" }}>{item.hint}</div>
                )}
              </div>
            </div>
          ))}
        </div>

        {completeness.actionableRecommendations.length > 0 && (
          <div
            style={{
              padding: "0.65rem 0.85rem",
              background: "rgb(233 173 91 / 8%)",
              border: "1px solid rgb(233 173 91 / 25%)",
              borderRadius: "var(--radius)",
              fontSize: "0.82rem",
              color: "var(--gradient)",
            }}
          >
            <strong>Recommended Next Action:</strong> {completeness.actionableRecommendations[0]}
          </div>
        )}
      </div>

      {/* Wizard Steps Navigation */}
      <div
        className="career-tabs-bar"
        role="tablist"
        aria-label="Profile wizard steps"
        style={{ marginTop: "0.5rem" }}
      >
        {steps.map((step, idx) => (
          <button
            key={step.id}
            type="button"
            role="tab"
            aria-selected={activeStep === idx}
            className="career-tab-btn"
            onClick={() => setActiveStep(idx)}
          >
            <span>{idx + 1}.</span> {step.label}
          </button>
        ))}
      </div>

      {/* Step Content */}
      <div className="career-card" style={{ padding: "1.5rem" }}>
        {activeStep === 0 && (
          <div className="career-form-group" style={{ gap: "1rem" }}>
            <h3>Identity & Career Summary</h3>
            <div className="career-form-group">
              <label htmlFor="fullName">Full Name</label>
              <input
                id="fullName"
                className="career-input"
                type="text"
                value={formData.fullName}
                onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="email">Email Address</label>
              <input
                id="email"
                className="career-input"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="headline">Professional Headline</label>
              <input
                id="headline"
                className="career-input"
                type="text"
                value={formData.headline}
                onChange={(e) => setFormData({ ...formData, headline: e.target.value })}
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="summary">Executive Summary & Goals</label>
              <textarea
                id="summary"
                className="career-textarea"
                rows={4}
                value={formData.summary}
                onChange={(e) => setFormData({ ...formData, summary: e.target.value })}
              />
            </div>
          </div>
        )}

        {activeStep === 1 && (
          <div className="career-form-group" style={{ gap: "1rem" }}>
            <h3>Preferred Career Tracks</h3>
            <p style={{ color: "var(--muted-text)", fontSize: "0.85rem" }}>
              Choose the opportunity processes that match your plans. Your profession, discipline,
              seniority, and keywords are personal profile data—not NEXUS defaults.
            </p>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              {(["phd", "cdi", "freelance"] as OpportunityTrack[]).map((track) => {
                const checked = formData.preferredTracks.includes(track);
                return (
                  <label
                    key={track}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      padding: "0.75rem 1rem",
                      background: checked ? "var(--soft-accent)" : "var(--surface-2)",
                      border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: "var(--radius)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...formData.preferredTracks, track]
                          : formData.preferredTracks.filter((t) => t !== track);
                        setFormData({ ...formData, preferredTracks: next });
                      }}
                    />
                    <strong>
                      {track === "phd" && "PhD / Doctoral Positions"}
                      {track === "cdi" && "Permanent Employment"}
                      {track === "freelance" && "Independent Work & Consulting"}
                    </strong>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {activeStep === 2 && (
          <div className="career-form-group" style={{ gap: "1rem" }}>
            <h3>Skills & Primary Discipline</h3>
            <div className="career-form-group">
              <label htmlFor="discipline">Primary Discipline / Domain</label>
              <input
                id="discipline"
                className="career-input"
                type="text"
                value={formData.primaryDiscipline}
                onChange={(e) => setFormData({ ...formData, primaryDiscipline: e.target.value })}
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="skills">Core Skills (comma separated)</label>
              <input
                id="skills"
                className="career-input"
                type="text"
                value={formData.skills.join(", ")}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    skills: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
          </div>
        )}

        {activeStep === 3 && (
          <div className="career-form-group" style={{ gap: "1rem" }}>
            <h3>Location & Remote Preferences</h3>
            <div className="career-form-group">
              <label htmlFor="remotePolicy">Remote Policy Preference</label>
              <select
                id="remotePolicy"
                className="career-select"
                value={formData.remotePreference}
                onChange={(e) =>
                  setFormData({ ...formData, remotePreference: e.target.value as LocationType })
                }
              >
                <option value="remote">100% Remote</option>
                <option value="hybrid">Hybrid (Remote + Periodic Onsite)</option>
                <option value="onsite">Onsite Only</option>
              </select>
            </div>
            <div className="career-form-group">
              <label htmlFor="targetLocations">Target Cities / Countries (comma separated)</label>
              <input
                id="targetLocations"
                className="career-input"
                type="text"
                value={formData.targetLocations.join(", ")}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    targetLocations: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
          </div>
        )}

        {activeStep === 4 && (
          <div className="career-form-group" style={{ gap: "1rem" }}>
            <h3>Compensation & Rate Expectations</h3>
            <div className="career-grid-3">
              <div className="career-form-group">
                <label htmlFor="minCdi">Minimum Annual Salary (€)</label>
                <input
                  id="minCdi"
                  className="career-input"
                  type="number"
                  value={formData.cdiPreferences?.targetMinAnnualSalary ?? 0}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      cdiPreferences: {
                        ...formData.cdiPreferences,
                        targetMinAnnualSalary: Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
              <div className="career-form-group">
                <label htmlFor="minTjm">Minimum Independent Daily Rate (€/day)</label>
                <input
                  id="minTjm"
                  className="career-input"
                  type="number"
                  value={formData.freelancePreferences?.targetDailyRateTjm ?? 0}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      freelancePreferences: {
                        ...formData.freelancePreferences,
                        targetDailyRateTjm: Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
              <div className="career-form-group">
                <label htmlFor="minPhd">Min PhD Monthly Stipend (€/month)</label>
                <input
                  id="minPhd"
                  className="career-input"
                  type="number"
                  value={formData.phdPreferences?.minMonthlyStipend ?? 0}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      phdPreferences: {
                        ...formData.phdPreferences,
                        minMonthlyStipend: Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>
        )}

        {activeStep === 5 && (
          <div className="career-form-group" style={{ gap: "1rem" }}>
            <h3>Academic Background & PhD Research Interest</h3>
            <div className="career-form-group">
              <label htmlFor="phdTopics">PhD Research Topics (comma separated)</label>
              <input
                id="phdTopics"
                className="career-input"
                type="text"
                value={formData.phdPreferences?.targetTopics?.join(", ") ?? ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    phdPreferences: {
                      ...formData.phdPreferences,
                      targetTopics: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="supervisors">Target Supervisors or Labs (comma separated)</label>
              <input
                id="supervisors"
                className="career-input"
                type="text"
                value={formData.phdPreferences?.preferredSupervisors?.join(", ") ?? ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    phdPreferences: {
                      ...formData.phdPreferences,
                      preferredSupervisors: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </div>
          </div>
        )}

        {activeStep === 6 && (
          <div className="career-form-group" style={{ gap: "1rem" }}>
            <h3>Languages & Visa Status</h3>
            <div className="career-form-group">
              <label htmlFor="visa">Work Authorization / Visa Status</label>
              <input
                id="visa"
                className="career-input"
                type="text"
                value={formData.visaStatus}
                onChange={(e) => setFormData({ ...formData, visaStatus: e.target.value })}
              />
            </div>
            <div className="career-form-group">
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input
                  type="checkbox"
                  checked={formData.requiresVisaSponsorship}
                  onChange={(e) =>
                    setFormData({ ...formData, requiresVisaSponsorship: e.target.checked })
                  }
                />
                Requires Visa Sponsorship for International Offers
              </label>
            </div>
          </div>
        )}

        {activeStep === 7 && (
          <div className="career-form-group" style={{ gap: "1rem" }}>
            <h3>Freelance Readiness</h3>
            <div className="career-grid-2">
              <div className="career-form-group">
                <label htmlFor="flDays">Available Days Per Week</label>
                <input
                  id="flDays"
                  className="career-input"
                  type="number"
                  min={1}
                  max={5}
                  value={formData.freelancePreferences?.availableDaysPerWeek ?? 4}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      freelancePreferences: {
                        ...formData.freelancePreferences,
                        availableDaysPerWeek: Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
              <div className="career-form-group">
                <label htmlFor="flStart">Earliest Available Start Date</label>
                <input
                  id="flStart"
                  className="career-input"
                  type="date"
                  value={formData.freelancePreferences?.earliestStartDate ?? ""}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      freelancePreferences: {
                        ...formData.freelancePreferences,
                        earliestStartDate: e.target.value,
                      },
                    })
                  }
                />
              </div>
            </div>
          </div>
        )}

        {/* Wizard Controls */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: "1.5rem",
            paddingTop: "1rem",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className="button"
              disabled={activeStep === 0 || loading || saving}
              onClick={() => setActiveStep((prev) => Math.max(0, prev - 1))}
            >
              Previous Step
            </button>
            <button
              type="button"
              className="button"
              disabled={activeStep === steps.length - 1 || loading || saving}
              onClick={() => setActiveStep((prev) => Math.min(steps.length - 1, prev + 1))}
            >
              Next Step
            </button>
          </div>

          <button
            type="button"
            className="button primary"
            disabled={loading || saving}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving Changes..." : "Save Profile"}
          </button>
        </div>

        {saveMessage && (
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: "0.5rem 0.75rem",
              borderRadius: "var(--radius)",
              background: saveMessage.includes("success")
                ? "rgb(95 211 154 / 12%)"
                : "rgb(242 118 118 / 12%)",
              color: saveMessage.includes("success") ? "var(--ok)" : "var(--down)",
              fontSize: "0.85rem",
            }}
          >
            {saveMessage}
          </div>
        )}
      </div>
    </div>
  );
}
