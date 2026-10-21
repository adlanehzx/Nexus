# NEXUS Architecture — 28. Enhanced Inter-Agent Collaboration

## 1. Context and Goals

In a coordinated multi-agent architecture, passing raw untyped strings (`<DEPENDENCY_RESULTS>`) presents
severe limitations:

- High risk of truncating large code patches and extensive audit logs;
- Inability to pass binary data (Chromium screenshots, diagrams, archives);
- Absence of structured semantic metadata (confidence levels, working hypotheses, open questions);
- Lack of an arbitration protocol when two agents arrive at conflicting conclusions;
- Inability for a running agent to dynamically spawn unpredicted follow-up tasks into the mission DAG.

This subsystem equips NEXUS with an end-to-end collaboration suite:

1. **Shared Artifact Store (`SharedArtifactStore`)** using URI scheme `artifact://` and SHA-256 integrity checks;
2. **Structured Task Outputs (`StructuredTaskOutput`)** with typed categories and execution metadata;
3. **Contradictory Debate & Cross-Critique Protocol** with neutral arbitration tasks (`nexus_cross_critique_arbitration`);
4. **Dynamic Subtask Proposals (`ProposedSubtask`)** integrated into active DAGs via `AgentRouter`;
5. **Dashboard Collaboration Panel** for inspecting shared artifacts, debates, and dynamic subtasks.

---

## 2. Shared Artifact Store (`SharedArtifactStore`)

Each mission maintains an isolated artifact workspace directory:

```
<missionWorkspace>/
└── artifacts/
    ├── manifest.json
    ├── investigate/
    │   ├── analysis.md
    │   └── network_scan.json
    └── implement/
        ├── patch.diff
        └── page_screenshot.png
```

### Atomic Manifest (`manifest.json`)

```typescript
export interface SharedArtifactRecord {
  id: string; // UUID v7
  missionKey: string;
  taskKey: string;
  name: string;
  relativePath: string;
  uri: string; // "artifact://investigate/patch.diff"
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  description: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
```

### Security Guarantees

- **Anti-Directory Traversal Isolation**: Destination paths must reside strictly within the canonical
  mission `artifacts/` folder. Path traversal attempts (`..`, symlinks, double slashes) are rejected
  with `ArtifactSecurityError`.
- **Strict File Permissions**: Directories created with `0700`, artifact files created with `0600`.
- **Enforced Storage Quotas**: 25 MB max per artifact, 100 MB max aggregate per mission.
- **REST Download API**: Accessible via `GET /api/v1/orchestrator/missions/:missionId/artifacts/download?uri=...`
  streaming content with verified MIME headers and SHA-256 ETag headers.

---

## 3. Structured Inter-Task Messages

Every agent generates structured outputs parsed according to:

```typescript
export interface StructuredTaskOutput {
  summary: string;
  payloadType:
    | "text"
    | "code_patch"
    | "audit_report"
    | "critique"
    | "browser_findings"
    | "hypothesis"
    | "contradiction_claim";
  confidenceScore: number; // 0.0 to 1.0
  data?: Record<string, unknown>;
  assumptions: string[];
  openQuestions: string[];
  proposedSubtasks: ProposedSubtask[];
  artifacts: { name: string; description: string; mimeType?: string; content?: string }[];
}
```

### Injection into Downstream Tasks

Dependent tasks receive a typed `<STRUCTURED_UPSTREAM_CONTEXT>` block containing:

- Source agent profile and originating task key;
- Payload category and confidence score;
- Factual summary;
- Explicit assumptions and open questions;
- References to shared artifacts (`artifact://...`) with file sizes and SHA-256 checksums.

---

## 4. Contradictory Debate and Cross-Critique Protocol

When a review or investigation agent flags a substantial contradiction (`payloadType: "contradiction_claim"`
or formal disagreement signals):

1. `AgentCollaborationService.detectContradiction` identifies conflicting conclusions between Task A and Task B.
2. An arbitration task `nexus_cross_critique_arbitration` is inserted into the DAG:
   - Dependency: awaits completion of both conflicting tasks;
   - Profile: `AgentRouter` selects a **neutral third-party agent** not involved in the original dispute;
   - Instruction: Analyze both perspectives, examine shared artifacts, reconcile contradictions, and
     render a definitive verdict for the final synthesis.

---

## 5. Dynamic Subtask Proposals

An executing agent may encounter an unexpected blocker or identify a critical test requirement.
It includes candidate tasks in its output under `proposedSubtasks`:

```typescript
export interface ProposedSubtask {
  key: string;
  title: string;
  instruction: string;
  reason: string;
  priority: "critical" | "recommended" | "optional";
  profile?: string;
  depends_on?: string[];
}
```

### Adoption Constraints

- Only high-priority subtasks (`critical` or `recommended`) are accepted;
- Bounded subtask limit (at most 3 dynamic subtasks per mission) to prevent DAG inflation;
- Cycle prevention checks and optimal profile assignment via `AgentRouter`;
- Final synthesis dependencies (`nexus_final_synthesis`) dynamically rewire to await validated subtasks.

---

## 6. REST Endpoints & Dashboard Interface

### REST Endpoints (`/api/v1/orchestrator/missions/:missionId/*`)

- `GET /artifacts`: Lists all registered artifacts for the mission.
- `GET /artifacts/download?uri=...`: Secure streaming file download.
- `POST /artifacts`: Upload an artifact programmatically or manually.
- `GET /collaboration`: Comprehensive collaboration summary (tasks, structured outputs, artifacts,
  debates, subtasks).

### Dashboard Interface (`apps/dashboard/src/ui/Sections.tsx`)

The `MissionCollaborationPanel` inside mission detail views enables:

- Browsing and downloading shared mission artifacts;
- Reviewing detected debate points alongside arbitration recommendations;
- Inspecting dynamic subtasks proposed by agents during mission execution.
