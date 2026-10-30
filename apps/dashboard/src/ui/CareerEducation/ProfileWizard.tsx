import { useState } from "react";
import type { CareerEducationProfile, OpportunityTrack, LocationType } from "@nexus/client-core";
import { useI18n } from "../i18n/index.js";
import { IconCheck } from "../icons.js";

interface ProfileWizardProps {
  profile: CareerEducationProfile;
  onUpdate: (updated: Partial<CareerEducationProfile>) => Promise<void>;
  loading?: boolean;
}

export function ProfileWizard({ profile, onUpdate, loading = false }: ProfileWizardProps) {
  const { tr } = useI18n();
  const [activeStep, setActiveStep] = useState<number>(0);
  const [formData, setFormData] = useState<CareerEducationProfile>(profile);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const steps = [
    {
      id: "identity",
      label: tr("Identity & Goals", "Identité & Objectifs"),
    },
    {
      id: "tracks",
      label: tr("Career Tracks", "Filières de carrière"),
    },
    {
      id: "skills",
      label: tr("Skills & Discipline", "Compétences & Discipline"),
    },
    {
      id: "location",
      label: tr("Location & Remote", "Localisation & Télétravail"),
    },
    {
      id: "compensation",
      label: tr("Compensation & Rates", "Rémunération & TJM"),
    },
    {
      id: "academic",
      label: tr("Academic & PhD", "Parcours académique & Doctorat"),
    },
    {
      id: "languages",
      label: tr("Languages & Visa", "Langues & Visa"),
    },
    {
      id: "freelance",
      label: tr("Freelance Details", "Modalités Freelance"),
    },
  ];

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      await onUpdate(formData);
      setSaveMessage(
        tr(
          "Profile updated successfully. Completeness score recalculated.",
          "Profil mis à jour avec succès. Score de complétude recalculé.",
        ),
      );
    } catch (err) {
      setSaveMessage(
        err instanceof Error
          ? err.message
          : tr("Failed to update profile.", "Échec de la mise à jour du profil."),
      );
    } finally {
      setSaving(false);
    }
  };

  const completeness = profile.completeness;

  return (
    <div className="career-tab-content" role="region" aria-label="Goals and Profile Wizard">
      {/* Completeness Meter */}
      <div className="completeness-gauge-box">
        <div className="completeness-header">
          <div>
            <strong style={{ fontSize: "1.05rem" }}>
              {tr("Profile Completeness", "Complétude du profil")}
            </strong>
            <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
              {tr(
                "A complete profile enables accurate match scoring and verified recommendations.",
                "Un profil complet permet un calcul précis des correspondances et des recommandations vérifiées.",
              )}
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
          aria-label={tr("Profile completeness score", "Score de complétude du profil")}
        >
          <div className="completeness-bar-fill" style={{ width: `${completeness.score}%` }} />
        </div>

        {/* Breakdown Checklist */}
        <div className="checklist-items">
          {completeness.breakdown.map((item) => (
            <div key={item.id} className={`checklist-item ${item.completed ? "done" : ""}`}>
              <span
                className="status-icon"
                aria-hidden="true"
                style={{ display: "inline-flex", alignItems: "center" }}
              >
                {item.completed ? (
                  <IconCheck size={14} color="var(--ok)" />
                ) : (
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      border: "1.5px solid var(--muted-text)",
                    }}
                  />
                )}
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
              background: "var(--nx-warn-bg)",
              border: "1px solid var(--nx-warn-line)",
              borderRadius: "var(--radius)",
              fontSize: "0.82rem",
              color: "var(--gradient)",
            }}
          >
            <strong>{tr("Recommended Next Action:", "Action recommandée :")}</strong>{" "}
            {completeness.actionableRecommendations[0]}
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
            <h3>{tr("Identity & Career Summary", "Identité & Résumé de Carrière")}</h3>
            <div className="career-form-group">
              <label htmlFor="fullName">{tr("Full Name", "Nom complet")}</label>
              <input
                id="fullName"
                className="career-input"
                type="text"
                value={formData.fullName}
                onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="email">{tr("Email Address", "Adresse e-mail")}</label>
              <input
                id="email"
                className="career-input"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="headline">{tr("Professional Headline", "Titre professionnel")}</label>
              <input
                id="headline"
                className="career-input"
                type="text"
                value={formData.headline}
                onChange={(e) => setFormData({ ...formData, headline: e.target.value })}
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="summary">
                {tr("Executive Summary & Goals", "Synthèse & Objectifs")}
              </label>
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
            <h3>{tr("Preferred Career Tracks", "Filières ciblées")}</h3>
            <p style={{ color: "var(--muted-text)", fontSize: "0.85rem" }}>
              {tr(
                "Choose the opportunity processes that match your plans. Your profession, discipline, seniority, and keywords are personal profile data—not NEXUS defaults.",
                "Sélectionnez les parcours qui correspondent à vos objectifs. Votre profession, discipline, niveau et mots-clés sont vos données personnelles, non des valeurs imposées par NEXUS.",
              )}
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
                      {track === "phd" && tr("PhD / Doctoral Positions", "Doctorat / Thèse CIFRE")}
                      {track === "cdi" && tr("Permanent Employment", "Poste CDI / Cadre")}
                      {track === "freelance" &&
                        tr("Independent Work & Consulting", "Missions Freelance & Conseil")}
                    </strong>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {activeStep === 2 && (
          <div className="career-form-group" style={{ gap: "1rem" }}>
            <h3>{tr("Skills & Primary Discipline", "Compétences & Discipline Principale")}</h3>
            <div className="career-form-group">
              <label htmlFor="discipline">
                {tr("Primary Discipline / Domain", "Discipline principale / Domaine")}
              </label>
              <input
                id="discipline"
                className="career-input"
                type="text"
                value={formData.primaryDiscipline}
                onChange={(e) => setFormData({ ...formData, primaryDiscipline: e.target.value })}
              />
            </div>
            <div className="career-form-group">
              <label htmlFor="skills">
                {tr("Core Skills (comma separated)", "Compétences clés (séparées par virgules)")}
              </label>
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
            <h3>
              {tr("Location & Remote Preferences", "Localisation & Préférences de Télétravail")}
            </h3>
            <div className="career-form-group">
              <label htmlFor="remotePolicy">
                {tr("Remote Policy Preference", "Préférence de télétravail")}
              </label>
              <select
                id="remotePolicy"
                className="career-select"
                value={formData.remotePreference}
                onChange={(e) =>
                  setFormData({ ...formData, remotePreference: e.target.value as LocationType })
                }
              >
                <option value="remote">{tr("100% Remote", "100% Télétravail")}</option>
                <option value="hybrid">
                  {tr(
                    "Hybrid (Remote + Periodic Onsite)",
                    "Hybride (Télétravail + Présentiel périodique)",
                  )}
                </option>
                <option value="onsite">{tr("Onsite Only", "Présentiel uniquement")}</option>
              </select>
            </div>
            <div className="career-form-group">
              <label htmlFor="targetLocations">
                {tr(
                  "Target Cities / Countries (comma separated)",
                  "Villes / Pays ciblés (séparés par virgules)",
                )}
              </label>
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
            <h3>{tr("Compensation & Rate Expectations", "Rémunération & Tarifs Attendus")}</h3>
            <div className="career-grid-3">
              <div className="career-form-group">
                <label htmlFor="minCdi">
                  {tr("Minimum Annual Salary (€)", "Salaire annuel minimum (€)")}
                </label>
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
                <label htmlFor="minTjm">
                  {tr("Minimum Independent Daily Rate (€/day)", "TJM minimum indépendant (€/jour)")}
                </label>
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
                <label htmlFor="minPhd">
                  {tr("Min PhD Monthly Stipend (€/month)", "Allocation doctorale min (€/mois)")}
                </label>
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
            <h3>
              {tr(
                "Academic Background & PhD Research Interest",
                "Parcours académique & Intérêts de recherche doctorale",
              )}
            </h3>
            <div className="career-form-group">
              <label htmlFor="phdTopics">
                {tr(
                  "PhD Research Topics (comma separated)",
                  "Thèmes de recherche doctorale (séparés par virgules)",
                )}
              </label>
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
              <label htmlFor="supervisors">
                {tr(
                  "Target Supervisors or Labs (comma separated)",
                  "Directeurs de thèse ou laboratoires cibles",
                )}
              </label>
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
            <h3>{tr("Languages & Visa Status", "Langues & Statut de Visa")}</h3>
            <div className="career-form-group">
              <label htmlFor="visa">
                {tr("Work Authorization / Visa Status", "Autorisation de travail / Statut de visa")}
              </label>
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
                {tr(
                  "Requires Visa Sponsorship for International Offers",
                  "Nécessite un parrainage de visa pour les offres internationales",
                )}
              </label>
            </div>
          </div>
        )}

        {activeStep === 7 && (
          <div className="career-form-group" style={{ gap: "1rem" }}>
            <h3>{tr("Freelance Readiness", "Disponibilité Freelance")}</h3>
            <div className="career-grid-2">
              <div className="career-form-group">
                <label htmlFor="flDays">
                  {tr("Available Days Per Week", "Jours disponibles par semaine")}
                </label>
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
                <label htmlFor="flStart">
                  {tr("Earliest Available Start Date", "Date de début au plus tôt")}
                </label>
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
              {tr("Previous Step", "Étape précédente")}
            </button>
            <button
              type="button"
              className="button"
              disabled={activeStep === steps.length - 1 || loading || saving}
              onClick={() => setActiveStep((prev) => Math.min(steps.length - 1, prev + 1))}
            >
              {tr("Next Step", "Étape suivante")}
            </button>
          </div>

          <button
            type="button"
            className="button primary"
            disabled={loading || saving}
            onClick={() => void handleSave()}
          >
            {saving
              ? tr("Saving Changes...", "Enregistrement...")
              : tr("Save Profile", "Enregistrer le profil")}
          </button>
        </div>

        {saveMessage && (
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: "0.5rem 0.75rem",
              borderRadius: "var(--radius)",
              background:
                saveMessage.includes("success") || saveMessage.includes("succès")
                  ? "var(--nx-ok-bg)"
                  : "rgb(242 118 118 / 12%)",
              color:
                saveMessage.includes("success") || saveMessage.includes("succès")
                  ? "var(--ok)"
                  : "var(--down)",
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
