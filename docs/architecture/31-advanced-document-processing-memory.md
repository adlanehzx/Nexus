# 31. Traitement Documentaire Avancé (Docling, PDF, OCR et Mémoire)

## 1. Contexte et Objectifs

Pour que les agents NEXUS puissent analyser des documents professionnels complexes et formuler des réponses étayées sans hallucination, le traitement documentaire fournit :

1. **Multi-formats universel** : Ingestion native des fichiers PDF (`.pdf`), Word (`.docx`), PowerPoint (`.pptx`), Markdown (`.md`) et texte brut (`.txt`).
2. **Support Docling & Fallback Local** :
   - Détection et délégation transparente à Docling si configuré.
   - Moteur local haute fidélité utilisant `pdftotext` (conservation du layout et pagination) et OCR `tesseract` en cas de document numérisé ou page scannée sans couche texte.
   - Extraction des fichiers Office (Word, PowerPoint) via inspection structurée XML (`word/document.xml`, `ppt/slides/slide*.xml`).
3. **Extraction structurée des tableaux** :
   - Détection automatique et conversion des tableaux en représentations matricielles `{ headers, rows }` et Markdown.
4. **Découpage hiérarchique (Hierarchical Chunking)** :
   - Découpage par section et page avec conservation de l'arbre parent (ex: `H1 > H2`).
   - Génération de citations stables et opposables : `doc://<documentId>/page/<pageNumber>#<sectionSlug>`.
   - Libellé humain : `Rapport_Securite.pdf (Page 3, § 2.1 Audit réseau)`.
5. **Injection dans la mémoire NEXUS (`@nexus/memory`)** :
   - `DocumentMemoryBridge` injecte les fragments avec leurs balises de citations opposables dans la mémoire longue durée (`LONG_TERM`, `SEMANTIC`).

## 2. Architecture Technique (`@nexus/documents`)

```
Fichier (.pdf, .docx, .pptx, .md)
            │
            ▼
    detectDocumentFormat()
            │
            ├─► Docling (si disponible)
            └─► Moteur Local :
                  ├─ pdftotext (-layout + form feed \x0c)
                  ├─ OCR Tesseract (fallback si < 20 car.)
                  ├─ Office XML (document.xml / slide*.xml)
                  └─ TablesExtractor (tableaux markdown / matriciels)
            │
            ▼
      ParsedDocument
            │
            ▼
     DocumentChunker (Hierarchical Chunking)
            │
            ▼
     DocumentChunk[] (avec citations doc://<id>/page/<n>#<section>)
            │
            ▼
  DocumentMemoryBridge
            │
            ▼
  NEXUS MemoryService (Mémoire sémantique LONG_TERM avec provenance)
```

## 3. Outils Natifs pour les Agents NEXUS

| Outil                       | Domaine                           | Niveau de Risque | Description                                                                         |
| --------------------------- | --------------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `document.parse`            | `filesystem.read`                 | `SAFE`           | Extrait le texte, métadonnées, pages et sections                                    |
| `document.extract_tables`   | `filesystem.read`                 | `SAFE`           | Extrait tous les tableaux structurés (en-têtes et lignes)                           |
| `document.ingest_to_memory` | `filesystem.read`, `memory.write` | `MEDIUM`         | Découpe le document et injecte les fragments indexés avec citations dans la mémoire |
