# Architecture NEXUS — 28. Collaboration Inter-Agents Améliorée

## 1. Contexte & Objectifs

Dans une architecture multi-agents coordonnée, le simple passage de texte brut non typé (`<DEPENDENCY_RESULTS>`) présente de sévères limites :

- Risque de tronquage intempestif des fichiers de code volumineux et des journaux d'audit ;
- Impossibilité de transmettre des données binaires (captures Chromium, schémas, archives) ;
- Absence de métadonnées sémantiques (niveau de confiance, hypothèses, questions ouvertes) ;
- Manque de protocole pour arbitrer les divergences quand deux agents formulent des conclusions opposées ;
- Incapacité pour un agent en cours d'exécution de soumettre des sous-tâches imprévues au DAG.

Le **Chantier 14** (finalisant la **Priorité 2**) dote NEXUS d'une suite de collaboration inter-agents complète :

1. **Espace d'artefacts partagés (`SharedArtifactStore`)** avec adressage URI `artifact://` et intégrité SHA-256 ;
2. **Messages structurés inter-tâches (`StructuredTaskOutput`)** avec typologie et métadonnées d'exécution ;
3. **Protocole de débat & cross-critique contradictoire** avec tâche d'arbitrage neutre (`nexus_cross_critique_arbitration`) ;
4. **Propositions dynamiques de sous-tâches** (`ProposedSubtask`) intégrées au DAG avec attribution par `AgentRouter` ;
5. **Panneau de collaboration du tableau de bord** pour l'inspection des artefacts et des débats.

---

## 2. Espace d'Artefacts Partagés (`SharedArtifactStore`)

Chaque mission dispose d'un espace d'artefacts sanctuarisé dans son workspace :

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

### Manifeste atomique (`manifest.json`)

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

### Garanties de sécurité

- **Isolation anti-directory traversal** : le chemin absolu de destination doit strictement résider sous le répertoire canonique `artifacts/` de la mission. Toute tentative (`..`, liens symboliques, barres obliques doubles) est rejetée avec `ArtifactSecurityError`.
- **Permissions strictes** : dossiers en `0700`, fichiers d'artefacts en `0600`.
- **Quotas stricts** : 25 Mo maximum par artefact, 100 Mo maximum cumulés par mission.
- **Accès API** : consultation et téléchargement direct via `GET /api/v1/orchestrator/missions/:missionId/artifacts/download?uri=...` avec en-têtes HTTP de type MIME et ETag basés sur le hash SHA-256.

---

## 3. Messages Structurés Inter-Tâches

Chaque agent produit un résultat qui est analysé et structuré selon le schéma :

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
  confidenceScore: number; // 0.0 à 1.0
  data?: Record<string, unknown>;
  assumptions: string[];
  openQuestions: string[];
  proposedSubtasks: ProposedSubtask[];
  artifacts: { name: string; description: string; mimeType?: string; content?: string }[];
}
```

### Injection dans les tâches aval

Les tâches dépendantes reçoivent un bloc typé `<STRUCTURED_UPSTREAM_CONTEXT>` contenant :

- Le profil et la tâche source ;
- Le type de payload et le niveau de confiance ;
- Le résumé factuel ;
- La liste explicite des hypothèses et questions ouvertes ;
- Les liens vers les artefacts partagés (`artifact://...`) avec leur taille et empreinte SHA-256.

---

## 4. Protocole de Débat & Cross-Critique Contradictoire

Lorsqu'un agent de revue ou d'investigation émet une contradiction majeure (`payloadType: "contradiction_claim"` ou signaux lexicaux de réfutation formelle avec divergence de conclusions) :

1. `AgentCollaborationService.detectContradiction` identifie le litige entre la tâche A et la tâche B.
2. Une tâche d'arbitrage `nexus_cross_critique_arbitration` est intercalée dans le DAG :
   - Dépendance : attend la fin des deux tâches conflictuelles ;
   - Profil : `AgentRouter` sélectionne en priorité un **agent tiers neutre** (non impliqué dans la dispute initiale) ;
   - Consigne : analyser les arguments respectifs, examiner les artefacts, démêler les contradictions et émettre un verdict d'arbitrage définitif pour la synthèse finale.

---

## 5. Proposition Dynamique de Sous-Tâches

Un agent en cours d'exécution peut identifier un point bloquant imprévu ou un besoin de test critique. Il inclut dans sa sortie une liste de `proposedSubtasks` :

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

### Règles d'adoption

- Seules les sous-tâches prioritaires (`critical` ou `recommended`) sont retenues ;
- Plafond de sous-tâches dynamiques par mission (3 maximum) pour empêcher toute dérive du DAG ;
- Vérification anti-cycle et assignation du profil optimal par `AgentRouter` si non renseigné ;
- Rebranchement automatique des dépendances de la synthèse finale (`nexus_final_synthesis`) pour attendre l'exécution de la sous-tâche validée.

---

## 6. Endpoints REST & Interface Tableau de Bord

### Endpoints REST (`/api/v1/orchestrator/missions/:missionId/*`)

- `GET /artifacts` : Liste des artefacts enregistrés dans la mission.
- `GET /artifacts/download?uri=...` : Téléchargement sécurisé avec streaming du fichier.
- `POST /artifacts` : Dépôt manuel ou programmatique d'un artefact.
- `GET /collaboration` : Vue d'ensemble collaborative (tâches, sorties structurées, artefacts, débats détectés, sous-tâches).

### Tableau de bord (`apps/dashboard/src/ui/Sections.tsx`)

Le panneau `MissionCollaborationPanel` intégré dans chaque carte de mission permet :

- De visualiser et télécharger directement les artefacts partagés ;
- De visualiser les débats contradictoires détectés avec la recommandation d'arbitrage ;
- De consulter les sous-tâches dynamiques proposées par les agents au cours de la mission.
