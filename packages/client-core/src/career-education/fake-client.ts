import { calculateProfileCompleteness } from "./completeness.js";
import type {
  Application,
  ApplicationStage,
  AuditEvent,
  CareerAnalytics,
  CareerEducationClient,
  CareerEducationProfile,
  CareerEducationSettings,
  ConfirmationRequest,
  ConfirmationStatus,
  Contact,
  CreateConfirmationInput,
  CreateDeadlineInput,
  CreateSavedSearchInput,
  Deadline,
  DocumentVariant,
  GenerateDocumentInput,
  Interview,
  MonitoredSource,
  Opportunity,
  OpportunityComparisonMatrix,
  OpportunitySearchQuery,
  OpportunitySearchResult,
  OpportunityTrack,
  Outcome,
  RecordOutcomeInput,
  SafeSearchResponse,
  SavedSearch,
} from "./types.js";

function uuid(): string {
  return "ce_" + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
}

const DEFAULT_PROFILE: CareerEducationProfile = {
  id: "profile_nexus_default",
  updatedAt: new Date().toISOString(),
  fullName: "Alex Rivera",
  email: "alex.rivera@example.org",
  headline: "Senior Distributed Systems Engineer & Research Specialist",
  summary:
    "10+ years engineering high-throughput distributed consensus, formal verification, and cloud platforms. Seeking high-impact PhD research, staff-level CDI positions, or specialized freelance architecture missions.",
  preferredTracks: ["phd", "cdi", "freelance"],
  primaryDiscipline: "Distributed Systems & Formal Methods",
  skills: [
    "Rust",
    "Go",
    "Distributed Consensus",
    "Formal Verification (TLA+)",
    "Kubernetes",
    "Linux Systems",
    "Performance Profiling",
  ],
  targetLocations: ["Paris, France", "Remote (EU/Worldwide)"],
  remotePreference: "hybrid",
  languages: [
    { language: "English", proficiency: "native" },
    { language: "French", proficiency: "fluent" },
  ],
  visaStatus: "EU Citizen (No sponsorship needed)",
  requiresVisaSponsorship: false,
  education: [
    {
      degree: "Master of Science in Computer Science",
      institution: "Sorbonne University",
      fieldOfStudy: "Distributed Computing & Algorithms",
      graduationYear: 2018,
      thesisTitle: "Optimizing Byzantine Fault Tolerant Consensus under Asynchronous Networks",
      publications: ["Fault Tolerance in Multi-Region Consensus (IEEE Conf 2019)"],
    },
  ],
  cdiPreferences: {
    targetMinAnnualSalary: 95000,
    targetMaxAnnualSalary: 130000,
    currency: "EUR",
    desiredRoles: ["Staff Engineer", "Principal Architect", "Distributed Systems Lead"],
    seniority: ["senior", "staff", "principal"],
    noticePeriodMonths: 2,
  },
  phdPreferences: {
    targetTopics: [
      "Formal Verification of Consensus Protocols",
      "Byzantine Agreement in Heterogeneous Networks",
      "Automated Theorem Proving for Storage Engines",
    ],
    preferredSupervisors: ["Dr. H. Vance (Inria)", "Prof. M. Laurent (Sorbonne)"],
    targetInstitutionsOrLabs: ["Inria Paris", "Sorbonne University - LIP6", "CNRS"],
    fundingModels: ["cifre", "anr", "erc", "doctoral_school"],
    minMonthlyStipend: 2400,
    currency: "EUR",
    prerequisitesMet: ["MSc Degree", "Peer-reviewed Publication", "TLA+ Proficiency"],
  },
  freelancePreferences: {
    targetDailyRateTjm: 750,
    currency: "EUR",
    availableDaysPerWeek: 4,
    earliestStartDate: new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0] ?? "2026-11-15",
    minDurationMonths: 3,
    preferredIndustries: ["Fintech", "Cloud Infrastructure", "Decentralized Systems"],
    vatRegistered: true,
  },
  completeness: {
    score: 0,
    breakdown: [],
    missingCrucialFields: [],
    actionableRecommendations: [],
  },
};

DEFAULT_PROFILE.completeness = calculateProfileCompleteness(DEFAULT_PROFILE);

const DEFAULT_SETTINGS: CareerEducationSettings = {
  preferredLocations: ["Paris, France", "Remote EU", "Berlin, Germany"],
  remotePolicy: "hybrid",
  disciplinesAndKeywords: [
    "Distributed Systems",
    "Formal Verification",
    "Rust",
    "Consensus",
    "Site Reliability",
  ],
  seniorityLevels: ["senior", "staff", "principal"],
  targetTracks: ["phd", "cdi", "freelance"],
  minAnnualSalaryCdi: 95000,
  minDailyRateTjmFreelance: 700,
  minMonthlyStipendPhd: 2200,
  currency: "EUR",
  languages: ["English", "French"],
  visaRequirement: "No sponsorship required",
  phdTopics: ["Formal Verification", "Distributed Consensus", "BFT Protocols"],
  phdSupervisors: ["Dr. H. Vance", "Prof. M. Laurent"],
  phdFundingTypes: ["CIFRE", "ANR", "ERC"],
  freelanceAvailableStartDate: "2026-11-15",
  freelanceDaysPerWeek: 4,
  excludedSources: ["sketchy-boards.internal", "spammy-recruiters.net"],
  excludedOrganizations: ["Predatory Publishing Lab Ltd"],
  quietHours: {
    enabled: true,
    start: "22:00",
    end: "08:00",
    timezone: "Europe/Paris",
  },
  retentionDays: 180,
  offlineSimulation: false,
  degradedFeedSimulation: false,
};

const SEED_OPPORTUNITIES: Opportunity[] = [
  {
    id: "opp_phd_sorbonne_01",
    track: "phd",
    title: "PhD in Formal Verification of Distributed Consensus Protocols",
    organization: "Sorbonne University / Inria Paris",
    departmentOrLab: "LIP6 - Formal Methods and Distributed Systems Group",
    location: "Paris, France",
    remotePolicy: "hybrid",
    description:
      "A fully funded 3-year doctoral research position focused on automated verification of asynchronous Byzantine Fault Tolerant consensus algorithms. Collaboration with industrial partners under CIFRE/ANR framework.",
    publishedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    discoveredAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    sourceUrl: "https://doctoral-school.sorbonne-universite.fr/offers/lip6-phd-2026-04",
    sourceFeedName: "Inria & Sorbonne Doctoral Feed",
    staleness: "fresh",
    duplicate: {
      isDuplicate: false,
      reason: "none",
    },
    citations: [
      {
        id: "cite_phd_01",
        quote: "Fully funded 36-month CIFRE/ANR grant with competitive gross stipend of €2,600/month.",
        url: "https://doctoral-school.sorbonne-universite.fr/offers/lip6-phd-2026-04",
        title: "Doctoral Contract Notice 2026-04",
        documentSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        verified: true,
        claim: "Funding is fully guaranteed for 3 years",
      },
    ],
    match: {
      score: 96,
      rationale:
        "Outstanding match: directly aligns with Master's thesis topic, mentions Dr. H. Vance as co-advisor, meets minimum stipend requirement.",
      strengths: [
        "Direct topical match: BFT consensus and formal methods",
        "Co-advised by preferred supervisor Dr. H. Vance",
        "Stipend (€2,600/mo) exceeds target (€2,400/mo)",
        "Location: Paris (Onsite/Hybrid)",
      ],
      gaps: [],
      breakdown: {
        skills: 98,
        compensation: 95,
        location: 100,
        trackFit: 95,
      },
    },
    phdDetails: {
      topic: "Automated Verification of Asynchronous BFT Consensus",
      supervisors: ["Dr. H. Vance (Inria)", "Prof. M. Laurent (Sorbonne)"],
      lab: "LIP6 - Distributed Algorithms Group",
      doctoralSchool: "EDITE de Paris (ED130)",
      fundingType: "CIFRE / ANR Collaboration",
      monthlyStipend: 2600,
      currency: "EUR",
      durationYears: 3,
      prerequisites: ["Master's in Computer Science", "TLA+ or Coq knowledge", "English fluency"],
    },
    workflowStatus: "shortlisted",
  },
  {
    id: "opp_cdi_cloudscale_02",
    track: "cdi",
    title: "Staff Distributed Systems Engineer - Storage & Replication",
    organization: "CloudScale Infrastructure Europe",
    departmentOrLab: "Core Platform Group",
    location: "Paris, France / Berlin, Germany",
    remotePolicy: "hybrid",
    description:
      "Permanent contract (CDI) architecting next-generation distributed block storage and metadata consensus engine handling petabyte-scale persistence.",
    publishedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    discoveredAt: new Date(Date.now() - 4 * 86400000).toISOString(),
    sourceUrl: "https://careers.cloudscale.eu/engineering/staff-systems-engineer",
    sourceFeedName: "European Tech Careers Direct Feed",
    staleness: "fresh",
    duplicate: {
      isDuplicate: false,
      reason: "none",
    },
    citations: [
      {
        id: "cite_cdi_01",
        quote: "Permanent CDI contract, base compensation between €105,000 and €120,000 with equity package.",
        url: "https://careers.cloudscale.eu/engineering/staff-systems-engineer",
        title: "Job Specification - CloudScale Staff Engineer",
        documentSha256: "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
        verified: true,
        claim: "Compensation meets Staff level criteria",
      },
    ],
    match: {
      score: 93,
      rationale:
        "High alignment with Rust, consensus protocol engineering, and hybrid European working policy.",
      strengths: [
        "Salary €105k-€120k within target range",
        "Core stack: Rust, Paxos/Raft consensus, Linux eBPF",
        "Permanent CDI contract with EU jurisdiction protections",
      ],
      gaps: ["Requires 2 days/month onsite in Berlin or Paris"],
      breakdown: {
        skills: 95,
        compensation: 92,
        location: 90,
        trackFit: 96,
      },
    },
    cdiDetails: {
      seniority: "staff",
      salaryMin: 105000,
      salaryMax: 120000,
      currency: "EUR",
      benefits: ["Equity (BSPCE)", "Hybrid remote budget", "Comprehensive health coverage"],
      trialPeriodMonths: 3,
      responsibilities: [
        "Lead technical roadmap for distributed metadata layer",
        "Mentor 8 core infrastructure engineers",
        "Formalize invariants using TLA+ models",
      ],
    },
    workflowStatus: "applied",
  },
  {
    id: "opp_freelance_fintech_03",
    track: "freelance",
    title: "Lead SRE & Resilience Architect (6 Months Mission)",
    organization: "Fintech Scaling Ltd",
    departmentOrLab: "Core Infrastructure",
    location: "Remote (EU)",
    remotePolicy: "remote",
    description:
      "Freelance consulting mission to harden banking ledger failover mechanisms, eliminate latency spikes, and conduct chaos engineering simulations.",
    publishedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    discoveredAt: new Date(Date.now() - 6 * 86400000).toISOString(),
    sourceUrl: "https://missions.fintech-freelance.io/lead-sre-architect-2026",
    sourceFeedName: "EU Freelance Verified Contracts",
    staleness: "fresh",
    duplicate: {
      isDuplicate: false,
      reason: "none",
    },
    citations: [
      {
        id: "cite_fl_01",
        quote: "Daily rate €800/day HT, estimated duration 6 months with 4 days/week commitment.",
        url: "https://missions.fintech-freelance.io/lead-sre-architect-2026",
        title: "Tender Offer - Resilience Architect",
        documentSha256: "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
        verified: true,
        claim: "Daily rate matches expectations",
      },
    ],
    match: {
      score: 91,
      rationale:
        "Daily rate €800 exceeds target €750; flexible 4 days/week allocation fits research commitments.",
      strengths: [
        "TJM €800/day exceeds target TJM (€750)",
        "4 days per week schedule matches availability",
        "100% remote within European timezones",
      ],
      gaps: ["Strict 24/7 on-call rotation during 2 deployment weekends"],
      breakdown: {
        skills: 90,
        compensation: 98,
        location: 95,
        trackFit: 90,
      },
    },
    freelanceDetails: {
      dailyRateMin: 780,
      dailyRateMax: 820,
      currency: "EUR",
      estimatedDaysTotal: 96,
      daysPerWeek: 4,
      durationMonths: 6,
      startDate: "2026-11-20",
      clientIndustry: "Regulated Financial Services",
    },
    workflowStatus: "inbox",
  },
  {
    id: "opp_cdi_cloudscale_dup_04",
    track: "cdi",
    title: "Staff Distributed Systems Engineer - Storage & Replication (Syndicated)",
    organization: "CloudScale Infrastructure Europe",
    departmentOrLab: "Core Platform Group",
    location: "Paris, France",
    remotePolicy: "hybrid",
    description:
      "Cross-posted listing of the CloudScale Staff Distributed Systems Engineer opening on aggregator boards.",
    publishedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
    discoveredAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    sourceUrl: "https://aggregator-tech.example.com/listings/cloudscale-staff-systems",
    sourceFeedName: "Public Job Aggregator Feed",
    staleness: "fresh",
    duplicate: {
      isDuplicate: true,
      originalOpportunityId: "opp_cdi_cloudscale_02",
      reason: "canonical_url",
    },
    citations: [
      {
        id: "cite_dup_01",
        quote: "Canonical original: https://careers.cloudscale.eu/engineering/staff-systems-engineer",
        url: "https://aggregator-tech.example.com/listings/cloudscale-staff-systems",
        title: "Syndicated Aggregator Entry",
        documentSha256: "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
        verified: true,
      },
    ],
    match: {
      score: 93,
      rationale: "Duplicate marker active: matches canonical URL from primary CloudScale posting.",
      strengths: ["Identical to shortlisted posting opp_cdi_cloudscale_02"],
      gaps: ["Duplicate posting on aggregator site"],
      breakdown: { skills: 95, compensation: 92, location: 90, trackFit: 96 },
    },
    cdiDetails: {
      seniority: "staff",
      salaryMin: 105000,
      salaryMax: 120000,
      currency: "EUR",
      benefits: ["Equity"],
      trialPeriodMonths: 3,
      responsibilities: ["Core distributed systems development"],
    },
    workflowStatus: "dismissed",
  },
  {
    id: "opp_phd_stale_05",
    track: "phd",
    title: "PhD Fellow in Cloud Database Sharding (Archived / Stale)",
    organization: "Technical University of Munich (TUM)",
    departmentOrLab: "Data Systems Chair",
    location: "Munich, Germany",
    remotePolicy: "onsite",
    description:
      "Research position on distributed query execution. Note: Application deadline expired 45 days ago.",
    publishedAt: new Date(Date.now() - 110 * 86400000).toISOString(),
    discoveredAt: new Date(Date.now() - 100 * 86400000).toISOString(),
    sourceUrl: "https://www.tum.de/in/chair/jobs/phd-sharding-2025",
    sourceFeedName: "Academic Feeds Europe",
    staleness: "stale",
    duplicate: {
      isDuplicate: false,
      reason: "none",
    },
    citations: [
      {
        id: "cite_stale_01",
        quote: "Applications close on August 15, 2026. Submissions after this date are not considered.",
        url: "https://www.tum.de/in/chair/jobs/phd-sharding-2025",
        title: "TUM Job Posting Archive",
        documentSha256: "ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d",
        verified: true,
      },
    ],
    match: {
      score: 62,
      rationale: "Opportunity is stale (published > 90 days ago, closed deadline).",
      strengths: ["Good academic reputation"],
      gaps: ["Posting has expired", "Requires German language B2", "Relocation to Munich required"],
      breakdown: { skills: 75, compensation: 70, location: 40, trackFit: 60 },
    },
    phdDetails: {
      topic: "Distributed Query Execution",
      supervisors: ["Prof. T. Neumann"],
      lab: "Database Systems",
      doctoralSchool: "TUM Graduate School",
      fundingType: "TV-L E13 (100%)",
      monthlyStipend: 2400,
      currency: "EUR",
      durationYears: 4,
      prerequisites: ["C++ proficiency"],
    },
    workflowStatus: "dismissed",
  },
  {
    id: "opp_junior_marketing_06",
    track: "cdi",
    title: "Junior Marketing Coordinator (Low Match Filter Test)",
    organization: "Global Media Ventures",
    location: "London, UK",
    remotePolicy: "onsite",
    description: "Junior digital marketing campaign organizer and social media scheduler.",
    publishedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    discoveredAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    sourceUrl: "https://example-jobs.com/marketing-junior",
    sourceFeedName: "General Open Web Feed",
    staleness: "fresh",
    duplicate: { isDuplicate: false, reason: "none" },
    citations: [],
    match: {
      score: 18,
      rationale: "Severe mismatch across skills, discipline, and compensation expectations.",
      strengths: [],
      gaps: [
        "Discipline mismatch: Marketing vs Distributed Systems",
        "Compensation below minimum target",
        "Onsite London location without visa support",
      ],
      breakdown: { skills: 5, compensation: 20, location: 25, trackFit: 15 },
    },
    cdiDetails: {
      seniority: "entry",
      salaryMin: 30000,
      salaryMax: 35000,
      currency: "GBP",
      benefits: ["Gym pass"],
      responsibilities: ["Post to social channels"],
    },
    workflowStatus: "dismissed",
  },
];

const SEED_SAVED_SEARCHES: SavedSearch[] = [
  {
    id: "search_phd_consensus",
    name: "PhD: Formal Verification & BFT Consensus",
    track: "phd",
    query: {
      term: "Formal Verification Consensus",
      track: "phd",
      minScore: 80,
      onlyFresh: true,
      includeDuplicates: false,
    },
    cadence: "daily",
    lastRunAt: new Date(Date.now() - 3600000).toISOString(),
    newMatchesCount: 2,
    active: true,
  },
  {
    id: "search_staff_cdi",
    name: "CDI: Staff Distributed Systems Engineer (Paris/Remote)",
    track: "cdi",
    query: {
      term: "Staff Systems Engineer Rust",
      track: "cdi",
      minScore: 85,
      onlyFresh: true,
      includeDuplicates: false,
    },
    cadence: "daily",
    lastRunAt: new Date(Date.now() - 7200000).toISOString(),
    newMatchesCount: 3,
    active: true,
  },
  {
    id: "search_freelance_sre",
    name: "Freelance: Resilience Architect TJM > 700€",
    track: "freelance",
    query: {
      term: "Resilience SRE Architect",
      track: "freelance",
      minScore: 85,
      onlyFresh: true,
      includeDuplicates: false,
    },
    cadence: "weekly",
    lastRunAt: new Date(Date.now() - 86400000).toISOString(),
    newMatchesCount: 1,
    active: true,
  },
];

const SEED_MONITORED_SOURCES: MonitoredSource[] = [
  {
    id: "source_inria_doctoral",
    name: "Inria / Sorbonne Doctoral Board",
    feedUrl: "https://doctoral-school.sorbonne-universite.fr/feed.rss",
    feedType: "rss",
    track: "phd",
    refreshIntervalHours: 12,
    status: "active",
    lastFetchAt: new Date(Date.now() - 1800000).toISOString(),
    citationTrustLevel: "high",
    itemsDiscoveredCount: 24,
  },
  {
    id: "source_euro_tech_jobs",
    name: "European Tech Careers Direct Feed",
    feedUrl: "https://careers.cloudscale.eu/rss.xml",
    feedType: "rss",
    track: "cdi",
    refreshIntervalHours: 6,
    status: "active",
    lastFetchAt: new Date(Date.now() - 3600000).toISOString(),
    citationTrustLevel: "high",
    itemsDiscoveredCount: 68,
  },
  {
    id: "source_freelance_eu",
    name: "EU Freelance Verified Contracts API",
    feedUrl: "https://missions.fintech-freelance.io/api/v1/verified-tenders",
    feedType: "api",
    track: "freelance",
    refreshIntervalHours: 24,
    status: "active",
    lastFetchAt: new Date(Date.now() - 7200000).toISOString(),
    citationTrustLevel: "high",
    itemsDiscoveredCount: 19,
  },
  {
    id: "source_unstable_external",
    name: "Legacy University Scraper Feed",
    feedUrl: "https://unstable-academic-feed.org/scraper",
    feedType: "html_scraper",
    track: "phd",
    refreshIntervalHours: 48,
    status: "degraded",
    lastFetchAt: new Date(Date.now() - 86400000).toISOString(),
    lastError: "HTTP 429: Source provider rate limited after 5 requests. Backoff in effect.",
    citationTrustLevel: "unverified",
    itemsDiscoveredCount: 2,
  },
];

const SEED_APPLICATIONS: Application[] = [
  {
    id: "app_phd_01",
    opportunityId: "opp_phd_sorbonne_01",
    opportunity: SEED_OPPORTUNITIES[0]!,
    stage: "shortlisted",
    stageHistory: [
      { stage: "discovered", transitionedAt: new Date(Date.now() - 3 * 86400000).toISOString() },
      {
        stage: "shortlisted",
        transitionedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        note: "Top doctoral priority - matches master's thesis research.",
      },
    ],
    tailoredDocumentIds: ["doc_cv_phd_01", "doc_statement_phd_01"],
    notes: "Emailed Prof. Laurent's lab coordinator for preprint references.",
    nextDeadlineAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    assignedContactIds: ["contact_dr_vance"],
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: "app_cdi_02",
    opportunityId: "opp_cdi_cloudscale_02",
    opportunity: SEED_OPPORTUNITIES[1]!,
    stage: "interviewing",
    stageHistory: [
      { stage: "discovered", transitionedAt: new Date(Date.now() - 10 * 86400000).toISOString() },
      { stage: "shortlisted", transitionedAt: new Date(Date.now() - 9 * 86400000).toISOString() },
      { stage: "preparing", transitionedAt: new Date(Date.now() - 8 * 86400000).toISOString() },
      { stage: "pending_approval", transitionedAt: new Date(Date.now() - 7 * 86400000).toISOString() },
      {
        stage: "submitted",
        transitionedAt: new Date(Date.now() - 6 * 86400000).toISOString(),
        note: "Approved by human operator after reviewing draft.",
      },
      {
        stage: "interviewing",
        transitionedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        note: "System Architecture interview scheduled with VP Engineering.",
      },
    ],
    tailoredDocumentIds: ["doc_cv_cloudscale_02", "doc_letter_cloudscale_02"],
    notes: "System design round scheduled. Focus on Raft log compaction & Paxos leases.",
    nextDeadlineAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    assignedContactIds: ["contact_recruiter_claudia"],
    updatedAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: "app_freelance_03",
    opportunityId: "opp_freelance_fintech_03",
    opportunity: SEED_OPPORTUNITIES[2]!,
    stage: "preparing",
    stageHistory: [
      { stage: "discovered", transitionedAt: new Date(Date.now() - 4 * 86400000).toISOString() },
      { stage: "shortlisted", transitionedAt: new Date(Date.now() - 3 * 86400000).toISOString() },
      {
        stage: "preparing",
        transitionedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
        note: "Generating tailored rate card and proposal summary.",
      },
    ],
    tailoredDocumentIds: ["doc_ratecard_fintech_03"],
    notes: "Proposal draft ready. Needs human confirmation before outreach email.",
    nextDeadlineAt: new Date(Date.now() + 8 * 86400000).toISOString(),
    assignedContactIds: ["contact_cto_mark"],
    updatedAt: new Date().toISOString(),
  },
];

const SEED_DOCUMENTS: DocumentVariant[] = [
  {
    id: "doc_cv_phd_01",
    applicationId: "app_phd_01",
    opportunityId: "opp_phd_sorbonne_01",
    type: "cv",
    title: "Curriculum Vitae (Doctoral Research Edition)",
    targetRole: "PhD Researcher in Formal Verification",
    targetOrganization: "Sorbonne University / Inria Paris",
    markdownContent: `# Alex Rivera
**Research Specialization**: Formal Verification of Distributed Consensus Protocols  
*Email*: alex.rivera@example.org | *Location*: Paris, France

## Academic Background
- **MSc Computer Science**, Sorbonne University (2018)
  - Thesis: *Optimizing Byzantine Fault Tolerant Consensus under Asynchronous Networks*
  - Co-advised with LIP6 Distributed Algorithms Group

## Relevant Publications
1. Rivera, A., et al. "Fault Tolerance in Multi-Region Consensus" (IEEE Distributed Systems Conf, 2019)
2. Invariant verification of quorum systems using TLA+ specification tooling.

## Key Research Capabilities
- **Formal Verification**: TLA+, TLC Model Checker, PlusCal
- **Implementation**: Rust, Go, Linux system call tracing
- **Theoretical Foundations**: State Machine Replication, PBFT, Raft, Paxos
`,
    tailoredHighlights: [
      "Highlighted Master's thesis conducted directly with LIP6 laboratory",
      "Prioritized peer-reviewed IEEE consensus publication",
      "Emphasized TLA+ formal specification expertise",
    ],
    diffSummary: {
      sectionsTailored: ["Academic Background", "Publications", "Formal Verification Tools"],
      skillsEmphasized: ["TLA+", "PBFT", "Formal Invariants"],
      customClausesAdded: ["Doctoral thesis alignment statement"],
    },
    baseDocumentRef: "base_cv_academic_v2",
    generatedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    digestSha256: "b6d81b360a5672d80c27430f39153e2c51525fed0796702c761ab8469b854e79",
  },
  {
    id: "doc_statement_phd_01",
    applicationId: "app_phd_01",
    opportunityId: "opp_phd_sorbonne_01",
    type: "research_statement",
    title: "Research Statement & Doctoral Proposal Outline",
    targetRole: "PhD Researcher in Formal Verification",
    targetOrganization: "Sorbonne University / Inria Paris",
    markdownContent: `# Research Proposal Statement
**Applicant**: Alex Rivera  
**Prospective Advisors**: Dr. H. Vance, Prof. M. Laurent  
**Topic**: Automated Invariant Verification in Asynchronous Byzantine Consensus

### 1. Motivation & State of the Art
Modern geo-distributed state machine replication protocols often sacrifice safety bounds when experiencing network partitions. Formal inductive invariants can guarantee absence of fork conditions.

### 2. Proposed Methodology
1. Specification of asynchronous crash-recovery and Byzantine fault models in TLA+.
2. Inductive invariant synthesis with bounded model checking.
3. Translation to verifiable Rust implementation kernel with zero-copy networking.

### 3. Timeline
- Year 1: Rigorous specification & proof of safety invariants.
- Year 2: Empirical evaluation and CIFRE industrial testbed deployment.
- Year 3: Synthesis of automated invariant synthesis tooling & thesis dissertation.
`,
    tailoredHighlights: [
      "Addresses specific LIP6 research problem statement",
      "Proposes clear 3-year phased research milestone plan",
    ],
    diffSummary: {
      sectionsTailored: ["Methodology", "Timeline", "Advisor alignment"],
      skillsEmphasized: ["Inductive Invariants", "CIFRE Industrial Integration"],
      customClausesAdded: ["Three-year research milestone breakdown"],
    },
    baseDocumentRef: "base_statement_template",
    generatedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    digestSha256: "d4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35",
  },
  {
    id: "doc_cv_cloudscale_02",
    applicationId: "app_cdi_02",
    opportunityId: "opp_cdi_cloudscale_02",
    type: "cv",
    title: "Staff Systems Engineer CV (CloudScale Edition)",
    targetRole: "Staff Distributed Systems Engineer",
    targetOrganization: "CloudScale Infrastructure Europe",
    markdownContent: `# Alex Rivera
**Staff Distributed Systems Engineer**  
*Email*: alex.rivera@example.org | *Paris / Berlin / Remote*

## Executive Summary
10+ years architecting high-throughput distributed consensus, low-latency storage engines, and cloud persistence layers in Rust and Go.

## Professional Experience
- **Lead Distributed Systems Architect** (2021 - Present)
  - Designed distributed log engine handling 1.2M writes/sec with Raft consensus.
  - Eliminated p99 tail latency spikes by 42% via custom zero-copy memory buffers.
- **Senior Systems Engineer** (2018 - 2021)
  - Re-architected multi-datacenter replication protocol ensuring strict serializability.
`,
    tailoredHighlights: [
      "Emphasized 1.2M writes/sec distributed log architecture",
      "Focused on Rust low-level systems & zero-copy memory",
      "Highlighted team leadership and p99 latency reduction metrics",
    ],
    diffSummary: {
      sectionsTailored: ["Executive Summary", "Production Performance Metrics"],
      skillsEmphasized: ["Rust", "Raft Consensus", "Tail Latency Profiling"],
      customClausesAdded: ["Multi-datacenter strict serializability project brief"],
    },
    baseDocumentRef: "base_cv_industry_v3",
    generatedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    digestSha256: "7d793037a0760186574b0282f2f435e7b1e516b26955a52c2522731241404e7d",
  },
  {
    id: "doc_letter_cloudscale_02",
    applicationId: "app_cdi_02",
    opportunityId: "opp_cdi_cloudscale_02",
    type: "cover_letter",
    title: "Tailored Motivation Letter - CloudScale Core Platform",
    targetRole: "Staff Distributed Systems Engineer",
    targetOrganization: "CloudScale Infrastructure Europe",
    markdownContent: `Dear CloudScale Platform Engineering Team,

I am writing to express my strong enthusiasm for the Staff Distributed Systems Engineer position in your Core Platform group. Having followed CloudScale's contributions to open-source distributed storage, your petabyte-scale architectural challenges directly match my decade of experience in consensus protocols and high-throughput systems.

In my previous projects, I led the implementation of a Raft-based storage engine that withstood hostile network partitions while maintaining bounded tail latency. I look forward to bringing this expertise to your team.

Sincerely,  
Alex Rivera
`,
    tailoredHighlights: [
      "Referenced CloudScale's open-source contributions",
      "Linked background directly to petabyte-scale metadata challenge",
    ],
    diffSummary: {
      sectionsTailored: ["Technical Alignment", "Company Specifics"],
      skillsEmphasized: ["Consensus Invariants", "Core Storage Architecture"],
      customClausesAdded: ["Partition tolerance experience anecdote"],
    },
    baseDocumentRef: "base_letter_template",
    generatedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    digestSha256: "1f82c9d749a9979d3753e0f6b4d3f57288a911765c92befffe9b657218ef85c8",
  },
  {
    id: "doc_ratecard_fintech_03",
    applicationId: "app_freelance_03",
    opportunityId: "opp_freelance_fintech_03",
    type: "rate_card",
    title: "Freelance Architecture Brief & Rate Card",
    targetRole: "Lead SRE & Resilience Architect",
    targetOrganization: "Fintech Scaling Ltd",
    markdownContent: `# Freelance Consulting Terms & Service Brief
**Consultant**: Alex Rivera (Independent Systems Architect)  
**Client**: Fintech Scaling Ltd  
**Role**: Lead SRE & Banking Ledger Resilience Architect

### Commercial Terms
- **Daily Rate (TJM)**: €800 / day HT (excluding VAT)
- **Time Commitment**: 4 days per week (approx. 16 days/month)
- **Estimated Duration**: 6 Months (Total approx. 96 consulting days)
- **Payment Terms**: 30 days net from monthly timesheet acceptance

### Scope of Work
1. Comprehensive audit of distributed ledger failover mechanisms.
2. Chaos engineering drills simulating multi-AZ network splits.
3. Implementation of latency tracing and automated circuit-breaking.
`,
    tailoredHighlights: [
      "Transparent €800/day commercial structure matching tender",
      "Explicit 4 days/week allocation and milestone deliverable list",
    ],
    diffSummary: {
      sectionsTailored: ["Commercial Terms", "Chaos Engineering Deliverables"],
      skillsEmphasized: ["Banking Ledger Failover", "Circuit Breaking"],
      customClausesAdded: ["30-day payment term clause"],
    },
    baseDocumentRef: "base_ratecard_template",
    generatedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
    digestSha256: "2c624232cdd221771294dfbb310aca000a0df6ac8b66b696d90ef9f8bde6b01e",
  },
];

const SEED_DEADLINES: Deadline[] = [
  {
    id: "deadline_phd_sorbonne",
    opportunityId: "opp_phd_sorbonne_01",
    opportunityTitle: "PhD in Formal Verification of Distributed Consensus Protocols",
    organization: "Sorbonne University / Inria Paris",
    title: "CIFRE Doctoral Application File Cutoff",
    dueDate: new Date(Date.now() + 5 * 86400000).toISOString(),
    category: "application_deadline",
    priority: "high",
    completed: false,
    calendarSyncStatus: "not_synced",
  },
  {
    id: "deadline_cloudscale_interview",
    opportunityId: "opp_cdi_cloudscale_02",
    opportunityTitle: "Staff Distributed Systems Engineer",
    organization: "CloudScale Infrastructure Europe",
    title: "System Architecture Deep-Dive Interview",
    dueDate: new Date(Date.now() + 3 * 86400000).toISOString(),
    category: "interview",
    priority: "critical",
    completed: false,
    calendarSyncStatus: "confirmed",
    externalCalendarEventId: "gcal_event_cs_sys_arch_992",
  },
  {
    id: "deadline_fintech_proposal",
    opportunityId: "opp_freelance_fintech_03",
    opportunityTitle: "Lead SRE & Resilience Architect",
    organization: "Fintech Scaling Ltd",
    title: "Transmit Rate Card & Scope of Work Proposal",
    dueDate: new Date(Date.now() + 8 * 86400000).toISOString(),
    category: "follow_up",
    priority: "medium",
    completed: false,
    calendarSyncStatus: "drafted",
  },
];

const SEED_CONTACTS: Contact[] = [
  {
    id: "contact_dr_vance",
    opportunityId: "opp_phd_sorbonne_01",
    name: "Dr. Helena Vance",
    role: "Senior Researcher & Prospective PhD Co-Advisor",
    organization: "Inria Paris / LIP6",
    email: "helena.vance@inria.fr",
    notes: "Specializes in verified consensus and model checking. Met at EuroSys 2024.",
  },
  {
    id: "contact_recruiter_claudia",
    opportunityId: "opp_cdi_cloudscale_02",
    name: "Claudia Lindqvist",
    role: "Principal Talent Partner - Infrastructure",
    organization: "CloudScale Infrastructure Europe",
    email: "claudia.lindqvist@cloudscale.eu",
    notes: "Very responsive. Coordinating system architecture panel with VP Eng.",
  },
  {
    id: "contact_cto_mark",
    opportunityId: "opp_freelance_fintech_03",
    name: "Mark O'Connor",
    role: "Chief Technology Officer",
    organization: "Fintech Scaling Ltd",
    email: "mark.oconnor@fintech-scaling.io",
    notes: "Looking to begin engagement quickly. Emphasized reliability over new features.",
  },
];

const SEED_INTERVIEWS: Interview[] = [
  {
    id: "int_cloudscale_round2",
    applicationId: "app_cdi_02",
    round: 2,
    title: "Distributed Storage Invariants & Architecture",
    scheduledAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    durationMinutes: 75,
    interviewerNames: ["Dr. Erik S.", "Jens K. (VP Platform)"],
    format: "remote_video",
    questionsPrepped: [
      "How would you guarantee quorum reads during an asymmetric network partition?",
      "Tradeoffs between Raft joint consensus and single-server reconfiguration.",
      "eBPF tracing for p99 storage disk flush latency.",
    ],
    notes: "Prepared visual whiteboard diagrams of Raft log compaction.",
  },
];

const SEED_CONFIRMATIONS: ConfirmationRequest[] = [
  {
    id: "conf_app_phd_submit",
    actionType: "browser_submit_application",
    title: "Submit Doctoral Application to Sorbonne/Inria Portal",
    summary:
      "NEXUS browser worker prepared the complete doctoral application form on the university admissions gateway. Consequential external submission requires your explicit confirmation.",
    destination: "https://doctoral-school.sorbonne-universite.fr/apply/lip6-phd-2026-04",
    targetOpportunityId: "opp_phd_sorbonne_01",
    payload: {
      applicantName: "Alex Rivera",
      applicantEmail: "alex.rivera@example.org",
      degreeDeclared: "Master of Science in Computer Science",
      advisorChosen: "Dr. Helena Vance",
      proposedFunding: "CIFRE / ANR Grant",
    },
    attachedDocuments: [
      {
        documentId: "doc_cv_phd_01",
        title: "Curriculum Vitae (Doctoral Research Edition)",
        type: "cv",
        digest: "b6d81b360a5672d80c27430f39153e2c51525fed0796702c761ab8469b854e79",
      },
      {
        documentId: "doc_statement_phd_01",
        title: "Research Statement & Doctoral Proposal Outline",
        type: "research_statement",
        digest: "d4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35",
      },
    ],
    risks: [
      "External portal submission is irreversible once transmitted.",
      "Applicant contact details and full academic records will be transferred to university servers.",
      "Triggers official review by LIP6 Doctoral Selection Committee.",
    ],
    consequences: [
      "Your candidacy is officially locked in for the 2026 CIFRE doctoral cohort.",
      "An automated acknowledgement receipt will be dispatched to your email address.",
    ],
    requiresHumanApproval: true,
    status: "pending",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    expiresAt: new Date(Date.now() + 48 * 3600000).toISOString(),
  },
  {
    id: "conf_email_fintech_proposal",
    actionType: "gmail_send_draft",
    title: "Dispatch Freelance Rate Card & Proposal to CTO",
    summary:
      "NEXUS Google Workspace integration drafted an outreach email to Mark O'Connor with the attached commercial terms.",
    destination: "mark.oconnor@fintech-scaling.io",
    targetOpportunityId: "opp_freelance_fintech_03",
    payload: {
      recipient: "mark.oconnor@fintech-scaling.io",
      subject: "Alex Rivera - Freelance SRE & Resilience Architecture Proposal",
      bodyPreview:
        "Hi Mark, Following up on the resilience consulting tender, please find attached my service brief and commercial terms (€800/day HT, 4 days/week)...",
    },
    attachedDocuments: [
      {
        documentId: "doc_ratecard_fintech_03",
        title: "Freelance Architecture Brief & Rate Card",
        type: "rate_card",
        digest: "2c624232cdd221771294dfbb310aca000a0df6ac8b66b696d90ef9f8bde6b01e",
      },
    ],
    risks: [
      "Dispatches an email directly from your authenticated mailbox to an external client.",
      "Commits your commercial daily rate (€800/day) in writing.",
    ],
    consequences: [
      "Client CTO receives commercial tender proposal.",
      "May initiate formal contract review and NDAs.",
    ],
    requiresHumanApproval: true,
    status: "pending",
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    expiresAt: new Date(Date.now() + 72 * 3600000).toISOString(),
  },
  {
    id: "conf_cal_cloudscale_sync",
    actionType: "calendar_create_event",
    title: "Sync Architecture Interview to Primary Calendar",
    summary:
      "Add confirmed 75-minute technical interview with CloudScale Engineering to your primary Google Calendar.",
    destination: "user-calendar@nexus.local (Google Calendar)",
    targetOpportunityId: "opp_cdi_cloudscale_02",
    payload: {
      summary: "CloudScale Architecture Interview - Jens K. & Dr. Erik S.",
      start: new Date(Date.now() + 3 * 86400000).toISOString(),
      durationMinutes: 75,
      attendees: ["claudia.lindqvist@cloudscale.eu", "alex.rivera@example.org"],
    },
    attachedDocuments: [],
    risks: [
      "Mutates calendar entries and reserves active availability.",
      "Sends calendar invitations/updates to external interviewers.",
    ],
    consequences: [
      "Interview block marked as busy on calendar.",
      "NEXUS reminders will trigger 30 minutes prior.",
    ],
    requiresHumanApproval: true,
    status: "approved",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    decidedAt: new Date(Date.now() - 43200000).toISOString(),
    resolvedBy: "Alex Rivera (User)",
    decisionRationale: "Confirmed time with CloudScale recruiter.",
  },
];

const SEED_AUDIT_EVENTS: AuditEvent[] = [
  {
    id: "audit_init_01",
    timestamp: new Date(Date.now() - 86400000).toISOString(),
    actor: "system.init",
    action: "career_profile_loaded",
    targetResource: "profile_nexus_default",
    details: { initialCompletenessScore: 100 },
    outcome: "success",
    riskLevel: "low",
  },
  {
    id: "audit_sync_approved_02",
    timestamp: new Date(Date.now() - 43200000).toISOString(),
    actor: "user.alex",
    action: "confirmation_decision",
    targetResource: "conf_cal_cloudscale_sync",
    details: { decision: "approved", destination: "Google Calendar" },
    outcome: "success",
    riskLevel: "medium",
  },
];

/**
 * Deterministic, contract-backed fake implementation of CareerEducationClient.
 * Provides rich fake data across PhD, CDI, and Freelance tracks, enforces human confirmation
 * boundaries, respects SSRF safety rules, and simulates honest degraded/offline states.
 */
export class FakeCareerEducationClient implements CareerEducationClient {
  private profile: CareerEducationProfile = structuredClone(DEFAULT_PROFILE);
  private settings: CareerEducationSettings = structuredClone(DEFAULT_SETTINGS);
  private opportunities: Opportunity[] = structuredClone(SEED_OPPORTUNITIES);
  private savedSearches: SavedSearch[] = structuredClone(SEED_SAVED_SEARCHES);
  private monitoredSources: MonitoredSource[] = structuredClone(SEED_MONITORED_SOURCES);
  private applications: Application[] = structuredClone(SEED_APPLICATIONS);
  private documents: DocumentVariant[] = structuredClone(SEED_DOCUMENTS);
  private deadlines: Deadline[] = structuredClone(SEED_DEADLINES);
  private contacts: Contact[] = structuredClone(SEED_CONTACTS);
  private interviews: Interview[] = structuredClone(SEED_INTERVIEWS);
  private confirmations: ConfirmationRequest[] = structuredClone(SEED_CONFIRMATIONS);
  private auditEvents: AuditEvent[] = structuredClone(SEED_AUDIT_EVENTS);
  private outcomes: Outcome[] = [];

  private checkOffline(): void {
    if (this.settings.offlineSimulation) {
      throw new Error(
        "Network offline error: unable to establish connection with external career feeds.",
      );
    }
  }

  // ==========================================
  // PROFILE & SETTINGS
  // ==========================================

  async getProfile(): Promise<CareerEducationProfile> {
    await Promise.resolve();
    this.profile.completeness = calculateProfileCompleteness(this.profile);
    return structuredClone(this.profile);
  }

  async updateProfile(profile: Partial<CareerEducationProfile>): Promise<CareerEducationProfile> {
    await Promise.resolve();
    this.profile = {
      ...this.profile,
      ...profile,
      updatedAt: new Date().toISOString(),
    };
    this.profile.completeness = calculateProfileCompleteness(this.profile);

    this.recordAudit("profile_updated", this.profile.id, {
      newCompletenessScore: this.profile.completeness.score,
    });

    return structuredClone(this.profile);
  }

  async getSettings(): Promise<CareerEducationSettings> {
    await Promise.resolve();
    return structuredClone(this.settings);
  }

  async updateSettings(
    settings: Partial<CareerEducationSettings>,
  ): Promise<CareerEducationSettings> {
    await Promise.resolve();
    this.settings = {
      ...this.settings,
      ...settings,
    };

    this.recordAudit("settings_updated", "career_settings", {
      offlineSimulation: this.settings.offlineSimulation,
      degradedFeedSimulation: this.settings.degradedFeedSimulation,
    });

    return structuredClone(this.settings);
  }

  // ==========================================
  // OPPORTUNITIES & DISCOVERY
  // ==========================================

  async searchOpportunities(query: OpportunitySearchQuery): Promise<OpportunitySearchResult> {
    await Promise.resolve();
    this.checkOffline();

    let items = [...this.opportunities];

    if (query.track && query.track !== "all") {
      items = items.filter((o) => o.track === query.track);
    }

    if (query.locationType && query.locationType !== "all") {
      items = items.filter((o) => o.remotePolicy === query.locationType);
    }

    if (query.minScore !== undefined && query.minScore > 0) {
      items = items.filter((o) => o.match.score >= (query.minScore ?? 0));
    }

    if (query.onlyFresh) {
      items = items.filter((o) => o.staleness === "fresh");
    }

    if (!query.includeDuplicates) {
      items = items.filter((o) => !o.duplicate.isDuplicate);
    }

    if (query.term && query.term.trim().length > 0) {
      const termLower = query.term.toLowerCase().trim();
      items = items.filter(
        (o) =>
          o.title.toLowerCase().includes(termLower) ||
          o.organization.toLowerCase().includes(termLower) ||
          o.description.toLowerCase().includes(termLower) ||
          o.match.strengths.some((s) => s.toLowerCase().includes(termLower)),
      );
    }

    const stalenessBreakdown: Record<"fresh" | "aging" | "stale", number> = {
      fresh: items.filter((o) => o.staleness === "fresh").length,
      aging: items.filter((o) => o.staleness === "aging").length,
      stale: items.filter((o) => o.staleness === "stale").length,
    };

    const trackBreakdown: Record<OpportunityTrack, number> = {
      phd: items.filter((o) => o.track === "phd").length,
      cdi: items.filter((o) => o.track === "cdi").length,
      freelance: items.filter((o) => o.track === "freelance").length,
    };

    return {
      items: structuredClone(items),
      total: items.length,
      duplicateCount: items.filter((o) => o.duplicate.isDuplicate).length,
      stalenessBreakdown,
      trackBreakdown,
    };
  }

  async getOpportunity(id: string): Promise<Opportunity> {
    await Promise.resolve();
    const found = this.opportunities.find((o) => o.id === id);
    if (!found) {
      throw new Error(`Opportunity not found: ${id}`);
    }
    return structuredClone(found);
  }

  async toggleShortlist(id: string, shortlisted: boolean): Promise<Opportunity> {
    const opp = this.opportunities.find((o) => o.id === id);
    if (!opp) throw new Error(`Opportunity not found: ${id}`);

    opp.workflowStatus = shortlisted ? "shortlisted" : "inbox";

    // Auto-create application if shortlisting
    if (shortlisted) {
      const existingApp = this.applications.find((a) => a.opportunityId === id);
      if (!existingApp) {
        await this.createApplication(id);
      }
    }

    this.recordAudit("opportunity_shortlist_toggled", id, { shortlisted });
    return structuredClone(opp);
  }

  async compareOpportunities(ids: string[]): Promise<OpportunityComparisonMatrix> {
    await Promise.resolve();
    const matched = this.opportunities.filter((o) => ids.includes(o.id));
    if (matched.length === 0) {
      throw new Error("No valid opportunities provided for comparison.");
    }

    const metrics = [
      {
        key: "track",
        label: "Track / Contract",
        valuesByOpportunityId: Object.fromEntries(
          matched.map((o) => [o.id, o.track.toUpperCase()]),
        ),
      },
      {
        key: "organization",
        label: "Organization / Institution",
        valuesByOpportunityId: Object.fromEntries(matched.map((o) => [o.id, o.organization])),
      },
      {
        key: "compensation",
        label: "Compensation / Stipend / TJM",
        valuesByOpportunityId: Object.fromEntries(
          matched.map((o) => {
            if (o.phdDetails?.monthlyStipend) {
              return [o.id, `€${o.phdDetails.monthlyStipend}/mo (${o.phdDetails.fundingType})`];
            }
            if (o.cdiDetails?.salaryMin) {
              const minK = Math.round(o.cdiDetails.salaryMin / 1000);
              const maxK = Math.round((o.cdiDetails.salaryMax ?? o.cdiDetails.salaryMin) / 1000);
              return [o.id, `€${minK}k - €${maxK}k CDI`];
            }
            if (o.freelanceDetails?.dailyRateMin) {
              return [o.id, `€${o.freelanceDetails.dailyRateMin} - €${o.freelanceDetails.dailyRateMax}/day TJM`];
            }
            return [o.id, "N/A"];
          }),
        ),
      },
      {
        key: "remotePolicy",
        label: "Remote Flexibility",
        valuesByOpportunityId: Object.fromEntries(matched.map((o) => [o.id, o.remotePolicy])),
      },
      {
        key: "matchScore",
        label: "Explainable Match Score",
        valuesByOpportunityId: Object.fromEntries(
          matched.map((o) => [o.id, `${o.match.score}%`]),
        ),
        winnerOpportunityId: matched.reduce((prev, curr) =>
          curr.match.score > prev.match.score ? curr : prev,
        ).id,
      },
      {
        key: "citationsCount",
        label: "Verified Public Citations",
        valuesByOpportunityId: Object.fromEntries(
          matched.map((o) => [o.id, o.citations.filter((c) => c.verified).length]),
        ),
      },
      {
        key: "freshness",
        label: "Source Freshness",
        valuesByOpportunityId: Object.fromEntries(matched.map((o) => [o.id, o.staleness])),
      },
    ];

    const tradeoffsSummary = [
      "PhD offers academic prestige and deep research autonomy, but CDI offers significantly higher initial compensation.",
      "Freelance mission offers highest gross annualized earnings (€800/day = ~€150k annualized), but has limited 6-month durability.",
      "All shortlisted positions have verified public citations and satisfy minimum criteria.",
    ];

    return {
      opportunityIds: ids,
      opportunities: structuredClone(matched),
      metrics,
      tradeoffsSummary,
    };
  }

  // ==========================================
  // SAVED SEARCHES & MONITORED SOURCES
  // ==========================================

  async getSavedSearches(): Promise<SavedSearch[]> {
    await Promise.resolve();
    return structuredClone(this.savedSearches);
  }

  async createSavedSearch(input: CreateSavedSearchInput): Promise<SavedSearch> {
    await Promise.resolve();
    const item: SavedSearch = {
      id: uuid(),
      name: input.name,
      track: input.track,
      query: input.query,
      cadence: input.cadence,
      lastRunAt: new Date().toISOString(),
      newMatchesCount: 0,
      active: true,
    };
    this.savedSearches.push(item);
    this.recordAudit("saved_search_created", item.id, { name: item.name });
    return structuredClone(item);
  }

  async deleteSavedSearch(id: string): Promise<void> {
    await Promise.resolve();
    this.savedSearches = this.savedSearches.filter((s) => s.id !== id);
    this.recordAudit("saved_search_deleted", id, {});
  }

  async getMonitoredSources(): Promise<MonitoredSource[]> {
    await Promise.resolve();
    if (this.settings.degradedFeedSimulation) {
      return this.monitoredSources.map((s) => {
        if (s.id === "source_unstable_external") {
          return {
            ...s,
            status: "degraded",
            lastError: "Rate limit exceeded (HTTP 429) - simulated degraded state.",
          };
        }
        return s;
      });
    }
    return structuredClone(this.monitoredSources);
  }

  async refreshSource(id: string): Promise<MonitoredSource> {
    await Promise.resolve();
    this.checkOffline();
    const source = this.monitoredSources.find((s) => s.id === id);
    if (!source) throw new Error(`Source not found: ${id}`);

    if (id === "source_unstable_external" && this.settings.degradedFeedSimulation) {
      source.status = "degraded";
      source.lastError = "Rate limit exceeded (HTTP 429) from remote server. Backoff 3600s.";
      this.recordAudit("source_refresh_degraded", id, { status: source.status });
      return structuredClone(source);
    }

    source.lastFetchAt = new Date().toISOString();
    source.status = "active";
    delete source.lastError;
    source.itemsDiscoveredCount += 1;

    this.recordAudit("source_refreshed", id, { status: source.status });
    return structuredClone(source);
  }

  // ==========================================
  // APPLICATIONS & KANBAN
  // ==========================================

  async getApplications(): Promise<Application[]> {
    await Promise.resolve();
    return structuredClone(this.applications);
  }

  async createApplication(opportunityId: string): Promise<Application> {
    const opp = await this.getOpportunity(opportunityId);
    const existing = this.applications.find((a) => a.opportunityId === opportunityId);
    if (existing) return existing;

    const newApp: Application = {
      id: uuid(),
      opportunityId,
      opportunity: opp,
      stage: "shortlisted",
      stageHistory: [
        {
          stage: "shortlisted",
          transitionedAt: new Date().toISOString(),
          note: "Opportunity shortlisted by applicant.",
        },
      ],
      tailoredDocumentIds: [],
      notes: "",
      assignedContactIds: [],
      updatedAt: new Date().toISOString(),
    };

    this.applications.push(newApp);
    this.recordAudit("application_created", newApp.id, { opportunityId });
    return structuredClone(newApp);
  }

  async updateApplicationStage(
    id: string,
    stage: ApplicationStage,
    note?: string,
  ): Promise<Application> {
    await Promise.resolve();
    const app = this.applications.find((a) => a.id === id);
    if (!app) throw new Error(`Application not found: ${id}`);

    app.stage = stage;
    app.stageHistory.push({
      stage,
      transitionedAt: new Date().toISOString(),
      note: note ?? `Transitioned to stage ${stage}`,
    });
    app.updatedAt = new Date().toISOString();

    this.recordAudit("application_stage_updated", id, { stage, note });
    return structuredClone(app);
  }

  // ==========================================
  // TAILORED DOCUMENTS
  // ==========================================

  async getDocuments(applicationId?: string): Promise<DocumentVariant[]> {
    await Promise.resolve();
    if (applicationId) {
      return structuredClone(this.documents.filter((d) => d.applicationId === applicationId));
    }
    return structuredClone(this.documents);
  }

  async generateDocumentVariant(input: GenerateDocumentInput): Promise<DocumentVariant> {
    const opp = await this.getOpportunity(input.opportunityId);
    const docId = uuid();

    let title = `Tailored ${input.type.toUpperCase()}`;
    let markdown = `# Tailored Document\n\nTargeting ${opp.title} at ${opp.organization}.\n\n`;

    if (input.type === "cv") {
      title = `Tailored CV - ${opp.organization}`;
      markdown += `## Key Alignment\n- Specifically highlights matching competencies: ${opp.match.strengths.join(", ")}`;
    } else if (input.type === "cover_letter") {
      title = `Motivation Letter - ${opp.organization}`;
      markdown += `Dear Hiring Committee,\n\nI am thrilled to apply for ${opp.title}. Having evaluated your technical focus on ${opp.match.strengths[0] ?? "core systems"}, my profile provides immediate value.`;
    } else if (input.type === "research_statement") {
      title = `Research Statement - ${opp.title}`;
      markdown += `## Research Vision\n\nFocusing on formal proof invariants and distributed verification.`;
    } else if (input.type === "rate_card") {
      title = `Commercial Proposal & Rate Card - ${opp.organization}`;
      markdown += `## Commercial Terms\n- Daily Rate: €${opp.freelanceDetails?.dailyRateMin ?? 800}/day HT\n- Allocation: ${opp.freelanceDetails?.daysPerWeek ?? 4} days/week`;
    }

    const newDoc: DocumentVariant = {
      id: docId,
      applicationId: input.applicationId,
      opportunityId: input.opportunityId,
      type: input.type,
      title,
      targetRole: opp.title,
      targetOrganization: opp.organization,
      markdownContent: markdown,
      tailoredHighlights: opp.match.strengths,
      diffSummary: {
        sectionsTailored: ["Executive Pitch", "Matching Competencies"],
        skillsEmphasized: opp.match.strengths.slice(0, 3),
        customClausesAdded: ["Customized application statement"],
      },
      baseDocumentRef: "base_template_v1",
      generatedAt: new Date().toISOString(),
      digestSha256: Math.random().toString(36).substring(2) + "a8f9024f",
    };

    this.documents.push(newDoc);

    // Link to application if exists
    if (input.applicationId) {
      const app = this.applications.find((a) => a.id === input.applicationId);
      if (app && !app.tailoredDocumentIds.includes(docId)) {
        app.tailoredDocumentIds.push(docId);
        app.updatedAt = new Date().toISOString();
      }
    }

    this.recordAudit("document_variant_generated", docId, {
      type: input.type,
      opportunityId: input.opportunityId,
    });

    return structuredClone(newDoc);
  }

  // ==========================================
  // DEADLINES & CALENDAR
  // ==========================================

  async getDeadlines(): Promise<Deadline[]> {
    await Promise.resolve();
    return structuredClone(this.deadlines);
  }

  async createDeadline(input: CreateDeadlineInput): Promise<Deadline> {
    await Promise.resolve();
    const item: Deadline = {
      id: uuid(),
      opportunityId: input.opportunityId,
      opportunityTitle: input.opportunityTitle,
      organization: input.organization,
      title: input.title,
      dueDate: input.dueDate,
      category: input.category,
      priority: input.priority,
      completed: false,
      calendarSyncStatus: "not_synced",
    };
    this.deadlines.push(item);
    this.recordAudit("deadline_created", item.id, { title: item.title, dueDate: item.dueDate });
    return structuredClone(item);
  }

  async toggleDeadlineCompleted(id: string, completed: boolean): Promise<Deadline> {
    await Promise.resolve();
    const item = this.deadlines.find((d) => d.id === id);
    if (!item) throw new Error(`Deadline not found: ${id}`);
    item.completed = completed;
    this.recordAudit("deadline_completed_toggled", id, { completed });
    return structuredClone(item);
  }

  // ==========================================
  // CONTACTS, INTERVIEWS, OUTCOMES & ANALYTICS
  // ==========================================

  async getContacts(opportunityId?: string): Promise<Contact[]> {
    await Promise.resolve();
    if (opportunityId) {
      return structuredClone(this.contacts.filter((c) => c.opportunityId === opportunityId));
    }
    return structuredClone(this.contacts);
  }

  async getInterviews(applicationId?: string): Promise<Interview[]> {
    await Promise.resolve();
    if (applicationId) {
      return structuredClone(this.interviews.filter((i) => i.applicationId === applicationId));
    }
    return structuredClone(this.interviews);
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<Outcome> {
    const outcome: Outcome = {
      id: uuid(),
      applicationId: input.applicationId,
      opportunityId: input.opportunityId,
      decision: input.decision,
      decidedAt: new Date().toISOString(),
      finalOfferDetails: input.finalOfferDetails,
      feedbackReceived: input.feedbackReceived,
      retrospectiveNotes: input.retrospectiveNotes,
    };
    this.outcomes.push(outcome);

    // Update application stage accordingly
    const stageMap: Record<string, ApplicationStage> = {
      accepted: "offer",
      declined: "withdrawn",
      rejected: "rejected",
      withdrawn: "withdrawn",
    };
    const targetStage = stageMap[input.decision] ?? "offer";
    await this.updateApplicationStage(
      input.applicationId,
      targetStage,
      `Outcome recorded: ${input.decision}`,
    );

    this.recordAudit("outcome_recorded", outcome.id, { decision: input.decision });
    return structuredClone(outcome);
  }

  async getAnalytics(): Promise<CareerAnalytics> {
    await Promise.resolve();
    return {
      totalOpportunitiesDiscovered: this.opportunities.length + 18,
      totalShortlisted: this.applications.length,
      totalApplicationsSubmitted: 1,
      totalInterviewsConducted: 2,
      totalOffersReceived: 1,
      averageResponseTimeDays: 4.8,
      funnel: [
        { stage: "discovered", count: 24, conversionRateFromPrevious: 100 },
        { stage: "shortlisted", count: 6, conversionRateFromPrevious: 25 },
        { stage: "preparing", count: 3, conversionRateFromPrevious: 50 },
        { stage: "pending_approval", count: 2, conversionRateFromPrevious: 66 },
        { stage: "submitted", count: 2, conversionRateFromPrevious: 100 },
        { stage: "interviewing", count: 1, conversionRateFromPrevious: 50 },
        { stage: "offer", count: 1, conversionRateFromPrevious: 100 },
      ],
      trackBreakdown: {
        phd: { count: 8, successRate: 75 },
        cdi: { count: 11, successRate: 60 },
        freelance: { count: 5, successRate: 80 },
      },
      salaryDistributionBenchmark: {
        minObserved: 75000,
        medianObserved: 110000,
        maxObserved: 135000,
        userTarget: 95000,
      },
    };
  }

  // ==========================================
  // CONFIRMATIONS & STRICT SAFETY ADAPTERS
  // ==========================================

  async getConfirmations(status?: ConfirmationStatus): Promise<ConfirmationRequest[]> {
    await Promise.resolve();
    if (status) {
      return structuredClone(this.confirmations.filter((c) => c.status === status));
    }
    return structuredClone(this.confirmations);
  }

  async requestConfirmation(input: CreateConfirmationInput): Promise<ConfirmationRequest> {
    await Promise.resolve();
    const id = uuid();
    const ttl = input.ttlSeconds ?? 172800; // 48h default

    const conf: ConfirmationRequest = {
      id,
      actionType: input.actionType,
      title: input.title,
      summary: input.summary,
      destination: input.destination,
      targetOpportunityId: input.targetOpportunityId,
      payload: input.payload,
      attachedDocuments: input.attachedDocuments ?? [],
      risks: input.risks,
      consequences: input.consequences,
      requiresHumanApproval: true,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };

    this.confirmations.unshift(conf);
    this.recordAudit("confirmation_requested", id, {
      actionType: conf.actionType,
      destination: conf.destination,
      requiresHumanApproval: true,
    });

    return structuredClone(conf);
  }

  async resolveConfirmation(
    id: string,
    decision: "approve" | "reject" | "cancel",
    reason?: string,
  ): Promise<ConfirmationRequest> {
    await Promise.resolve();
    const conf = this.confirmations.find((c) => c.id === id);
    if (!conf) throw new Error(`Confirmation not found: ${id}`);

    // Check expiry
    if (new Date(conf.expiresAt).getTime() < Date.now()) {
      conf.status = "expired";
      this.recordAudit("confirmation_expired", id, {});
      throw new Error(`Confirmation ${id} has expired and cannot be approved.`);
    }

    if (decision === "approve") {
      conf.status = "approved";
      conf.decidedAt = new Date().toISOString();
      conf.resolvedBy = "Human Operator (Dashboard)";
      conf.decisionRationale = reason ?? "Explicit user approval granted in dashboard.";

      // If associated with application, advance stage
      if (conf.targetOpportunityId) {
        const app = this.applications.find(
          (a) => a.opportunityId === conf.targetOpportunityId,
        );
        if (app?.stage === "pending_approval") {
          app.stage = "submitted";
          app.stageHistory.push({
            stage: "submitted",
            transitionedAt: new Date().toISOString(),
            note: `Submitted after explicit human confirmation (${conf.id}).`,
          });
        }
      }

      this.recordAudit("confirmation_approved", id, {
        destination: conf.destination,
        rationale: conf.decisionRationale,
      });
    } else if (decision === "reject") {
      conf.status = "rejected";
      conf.decidedAt = new Date().toISOString();
      conf.resolvedBy = "Human Operator (Dashboard)";
      conf.decisionRationale = reason ?? "User explicitly rejected action.";

      this.recordAudit("confirmation_rejected", id, { reason });
    } else {
      conf.status = "cancelled";
      conf.decidedAt = new Date().toISOString();
      conf.resolvedBy = "Human Operator (Dashboard)";
      conf.decisionRationale = reason ?? "Cancelled by user.";

      this.recordAudit("confirmation_cancelled", id, { reason });
    }

    return structuredClone(conf);
  }

  async getAuditEvents(limit = 100): Promise<AuditEvent[]> {
    await Promise.resolve();
    return structuredClone(this.auditEvents.slice(0, limit));
  }

  private recordAudit(
    action: string,
    targetResource: string,
    details: Record<string, unknown>,
  ): void {
    const event: AuditEvent = {
      id: uuid(),
      timestamp: new Date().toISOString(),
      actor: "nexus.career_engine",
      action,
      targetResource,
      details,
      outcome: "success",
      riskLevel: action.includes("approval") || action.includes("confirm") ? "medium" : "low",
    };
    this.auditEvents.unshift(event);
  }

  // ==========================================
  // SAFE RESEARCH PLANE OPERATIONS
  // ==========================================

  async executeSafeSearch(
    query: string,
    track: OpportunityTrack | "all" = "all",
  ): Promise<SafeSearchResponse> {
    this.checkOffline();

    // Check for malicious SSRF attempt strings in query
    let blockedCount = 0;
    const lowerQuery = query.toLowerCase();
    if (
      lowerQuery.includes("127.0.0.1") ||
      lowerQuery.includes("localhost") ||
      lowerQuery.includes("169.254.169.254") ||
      lowerQuery.includes("metadata.google")
    ) {
      blockedCount += 1;
      this.recordAudit("ssrf_blocked", "safe_research_plane", { query, blockedCount });
      return {
        query,
        executedAt: new Date().toISOString(),
        results: [],
        blockedPrivateDestinationsCount: blockedCount,
        rateLimitRemaining: 98,
      };
    }

    const searchResult = await this.searchOpportunities({
      term: query,
      track,
      onlyFresh: true,
      includeDuplicates: false,
    });

    return {
      query,
      executedAt: new Date().toISOString(),
      results: searchResult.items,
      blockedPrivateDestinationsCount: 0,
      rateLimitRemaining: 95,
    };
  }

  async prepareDraftApplication(
    opportunityId: string,
    formValues: Record<string, string>,
  ): Promise<ConfirmationRequest> {
    const opp = await this.getOpportunity(opportunityId);
    const docs = await this.getDocuments();
    const matchingDocs = docs.filter((d) => d.opportunityId === opportunityId);

    const conf = await this.requestConfirmation({
      actionType: "browser_submit_application",
      title: `Submit External Application: ${opp.organization}`,
      summary: `Automated browser worker filled out the application form on ${opp.sourceUrl}. The action is paused and awaits your approval before submission.`,
      destination: opp.sourceUrl,
      targetOpportunityId: opportunityId,
      payload: formValues,
      attachedDocuments: matchingDocs.map((d) => ({
        documentId: d.id,
        title: d.title,
        type: d.type,
        digest: d.digestSha256,
      })),
      risks: [
        "Transmits application package directly to external server.",
        "Submission cannot be recalled once dispatched.",
      ],
      consequences: [
        `Enters selection pipeline for ${opp.title} at ${opp.organization}.`,
        "Applicant identity will be verified by external recruitment system.",
      ],
    });

    // Advance application to pending_approval if present
    const app = this.applications.find((a) => a.opportunityId === opportunityId);
    if (app) {
      await this.updateApplicationStage(
        app.id,
        "pending_approval",
        "Application draft prepared; awaiting human confirmation.",
      );
    }

    return conf;
  }

  async prepareDraftEmail(
    opportunityId: string,
    to: string,
    subject: string,
    body: string,
  ): Promise<ConfirmationRequest> {
    const opp = await this.getOpportunity(opportunityId);

    return this.requestConfirmation({
      actionType: "gmail_send_draft",
      title: `Send Application Outreach Email to ${to}`,
      summary: `A Gmail message draft has been generated for ${opp.title}. Will send from your primary account only upon your confirmation.`,
      destination: to,
      targetOpportunityId: opportunityId,
      payload: { to, subject, body },
      risks: [
        "Sends external email originating from your identity.",
        "Communication is permanently delivered to recipient.",
      ],
      consequences: [
        `Recipient at ${opp.organization} will receive outreach and application inquiry.`,
      ],
    });
  }

  async prepareDraftCalendarEvent(
    opportunityId: string,
    title: string,
    start: string,
    end: string,
  ): Promise<ConfirmationRequest> {
    const opp = await this.getOpportunity(opportunityId);

    return this.requestConfirmation({
      actionType: "calendar_create_event",
      title: `Create Calendar Event: ${title}`,
      summary: `Drafted an interview/follow-up event on Google Calendar for ${opp.organization}.`,
      destination: "Google Calendar (Primary)",
      targetOpportunityId: opportunityId,
      payload: { title, start, end, opportunityTitle: opp.title },
      risks: ["Reserves calendar time slot as busy."],
      consequences: ["NEXUS alerts and calendar notifications will trigger."],
    });
  }
}
