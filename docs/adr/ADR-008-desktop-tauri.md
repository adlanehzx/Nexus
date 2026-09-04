# ADR-008 — Desktop en Tauri v2

**Statut** : Proposé · 2026-09-01

## Contexte

Le cahier des charges suggère Tauri « si pertinent, sinon proposer une alternative justifiée ».
L'application desktop a deux rôles : client de conversation, et coquille de supervision du Device
Agent (statut, logs, politique locale, bouton pause).

## Décision

**Tauri v2**, UI React partagée avec le web, plus les intégrations natives (tray, raccourci global,
fenêtre spotlight, notifications, lancement au démarrage, deep links). Le Device Agent reste un
processus séparé (ADR-007) supervisé par l'app.

## Alternatives

- **Electron.** L'argument fort en sa faveur : une seule webview (Chromium) sur tous les OS, donc
  zéro surprise de rendu, et un écosystème mature (auto-update, packaging, crash reporting).
  Écarté : ~120 Mo de binaire contre ~10 Mo, 150–250 Mo de RSS au repos contre ~60 Mo, et un
  modèle de sécurité où tout est ouvert par défaut alors que Tauri exige une déclaration explicite
  des capacités — ce qui va dans le sens du reste de l'architecture.
- **Application web installée (PWA).** Zéro packaging, mais pas de tray, pas de raccourci global,
  pas de supervision de service local. Insuffisant pour le rôle de coquille.
- **Natif (WinUI/SwiftUI).** Meilleure intégration, mais deux UI à écrire et maintenir pour un
  bénéfice marginal sur ce produit.

## Conséquences

**Positives** — binaire léger, démarrage rapide, faible empreinte pour une app qui reste ouverte
en permanence ; permissions explicites ; auto-update signé fourni ; Rust disponible si l'on veut
plus tard descendre au niveau système.

**Négatives, acceptées** — la **webview dépend de l'OS** (WebView2 sur Windows, WKWebView sur
macOS, WebKitGTK sur Linux) : différences de rendu et de bugs CSS. Mitigation : UI volontairement
sobre, pas d'effets exotiques, matrice de test avec Windows en priorité (machine cible) puis
macOS. Écosystème plus jeune qu'Electron, moins de réponses toutes faites. Nécessite la chaîne
Rust en CI pour builder.

## Réversibilité

Le risque est contenu : l'UI est du React standard consommant `@nexus/sdk-client`. Basculer sur
Electron consisterait à remplacer la coquille, pas l'application.
