import type {
  CareerEducationProfile,
  CompletenessBreakdownItem,
  ProfileCompleteness,
} from "./types.js";

/**
 * Calculates profile completeness score and itemized breakdown.
 * Designed to provide clear actionable guidance to the user.
 */
export function calculateProfileCompleteness(
  profile: Partial<CareerEducationProfile>,
): ProfileCompleteness {
  const breakdown: CompletenessBreakdownItem[] = [
    {
      id: "identity_and_summary",
      label: "Identity & Professional Headline",
      completed: Boolean(
        profile.fullName?.trim() && profile.headline?.trim() && profile.summary?.trim(),
      ),
      weight: 15,
      hint: "Provide your full name, headline, and an executive career summary.",
    },
    {
      id: "preferred_tracks",
      label: "Career Tracks & Primary Discipline",
      completed: Boolean(
        profile.preferredTracks &&
          profile.preferredTracks.length > 0 &&
          profile.primaryDiscipline?.trim(),
      ),
      weight: 15,
      hint: "Select at least one track (PhD, CDI, Freelance) and your primary discipline.",
    },
    {
      id: "skills_and_expertise",
      label: "Core Skills & Domain Keywords",
      completed: Boolean(profile.skills && profile.skills.length >= 3),
      weight: 15,
      hint: "List at least 3 core technical or research skills.",
    },
    {
      id: "location_and_remote",
      label: "Location & Remote Preferences",
      completed: Boolean(
        profile.remotePreference &&
          profile.targetLocations &&
          profile.targetLocations.length > 0,
      ),
      weight: 10,
      hint: "Specify your remote work preference and target locations.",
    },
    {
      id: "compensation_rates",
      label: "Compensation & Rate Expectations",
      completed: Boolean(
        (profile.cdiPreferences?.targetMinAnnualSalary ?? 0) > 0 ||
          (profile.freelancePreferences?.targetDailyRateTjm ?? 0) > 0 ||
          (profile.phdPreferences?.minMonthlyStipend ?? 0) > 0,
      ),
      weight: 15,
      hint: "Set minimum compensation criteria (salary for CDI, TJM for freelance, or stipend for PhD).",
    },
    {
      id: "education_research",
      label: "Education & Academic Background",
      completed: Boolean(profile.education && profile.education.length > 0),
      weight: 10,
      hint: "Add your latest academic degrees, university, and thesis topic if applicable.",
    },
    {
      id: "languages_and_visa",
      label: "Languages & Visa Requirements",
      completed: Boolean(profile.languages && profile.languages.length > 0 && profile.visaStatus),
      weight: 10,
      hint: "List your languages with proficiency and specify your work authorization status.",
    },
    {
      id: "track_specific_readiness",
      label: "Track-Specific Readiness Details",
      completed: evaluateTrackSpecificDetails(profile),
      weight: 10,
      hint: "Complete details for your selected tracks (PhD topics, freelance availability, or CDI seniority).",
    },
  ];

  let totalScore = 0;
  const missingCrucialFields: string[] = [];
  const actionableRecommendations: string[] = [];

  for (const item of breakdown) {
    if (item.completed) {
      totalScore += item.weight;
    } else {
      missingCrucialFields.push(item.label);
      actionableRecommendations.push(item.hint);
    }
  }

  return {
    score: Math.min(100, Math.max(0, totalScore)),
    breakdown,
    missingCrucialFields,
    actionableRecommendations,
  };
}

function evaluateTrackSpecificDetails(profile: Partial<CareerEducationProfile>): boolean {
  if (!profile.preferredTracks || profile.preferredTracks.length === 0) {
    return false;
  }

  let satisfied = true;

  if (profile.preferredTracks.includes("phd")) {
    const phd = profile.phdPreferences;
    const hasTopics = Boolean(phd?.targetTopics && phd.targetTopics.length > 0);
    const hasFunding = Boolean(phd?.fundingModels && phd.fundingModels.length > 0);
    if (!hasTopics || !hasFunding) satisfied = false;
  }

  if (profile.preferredTracks.includes("freelance")) {
    const fl = profile.freelancePreferences;
    const hasTjm = Boolean(fl && fl.targetDailyRateTjm > 0);
    const hasDays = Boolean(fl && fl.availableDaysPerWeek > 0);
    if (!hasTjm || !hasDays) satisfied = false;
  }

  if (profile.preferredTracks.includes("cdi")) {
    const cdi = profile.cdiPreferences;
    const hasSalary = Boolean(cdi && cdi.targetMinAnnualSalary > 0);
    const hasSeniority = Boolean(cdi?.seniority && cdi.seniority.length > 0);
    if (!hasSalary || !hasSeniority) satisfied = false;
  }

  return satisfied;
}
