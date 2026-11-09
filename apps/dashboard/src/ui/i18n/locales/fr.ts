import type { Translations } from "../types.js";

export const fr: Translations = {
  common: {
    appName: "NEXUS",
    workspace: "ESPACE DE TRAVAIL",
    supervision: "SUPERVISION",
    system: "SYSTÈME",
    actions: {
      save: "Enregistrer",
      saving: "Enregistrement…",
      cancel: "Annuler",
      create: "Créer",
      delete: "Supprimer",
      edit: "Modifier",
      refresh: "Actualiser",
      filter: "Filtrer",
      search: "Rechercher",
      copy: "Copier",
      copied: "Copié !",
      pause: "Suspendre",
      resume: "Reprendre",
      test: "Tester",
      disconnect: "Déconnecter",
      close: "Fermer",
      back: "Retour",
      confirm: "Confirmer",
    },
    states: {
      active: "Actif",
      stopped: "Arrêté",
      idle: "En attente",
      running: "En cours",
      healthy: "Sain",
      degraded: "Dégradé",
      down: "Inaccessible",
      valid: "Valide",
      invalid: "Invalide",
      connected: "Connecté",
      pending: "En attente",
      succeeded: "Succès",
      failed: "Échoué",
      offline: "Hors ligne",
      online: "En ligne",
      paperOnly: "Simulation uniquement",
    },
    messages: {
      noData: "Aucune donnée",
      restoringSession: "Restauration de la session…",
      connecting: "Connexion en cours…",
      liveApi: "API en direct",
      apiUnreachable: "API inaccessible",
      themeToggle: "Basculer le thème",
      languageToggle: "Changer de langue",
      systemPauseNotice:
        "La pause système est active. Aucune tâche de fond ou répartition programmée ne sera exécutée.",
    },
  },
  nav: {
    groups: {
      workspaces: "Espaces de travail",
      supervision: "Supervision",
      control: "Contrôle",
      infrastructure: "Infrastructure",
      governance: "Gouvernance",
      system: "Système",
    },
    items: {
      chat: "Chat",
      "career-education": "Carrière & Éducation",
      "trading-lab": "Trading Lab",
      osint: "Espace OSINT",
      overview: "Vue d'ensemble",
      tasks: "Tâches",
      runs: "Exécutions d'agents",
      "mission-control": "Missions ACP",
      "dag-debugger": "Débogueur DAG",
      "run-comparison": "Comparaison d'exécutions",
      devices: "Appareils",
      workers: "Workers",
      tools: "Outils",
      mcp: "MCP",
      browser: "Navigateur",
      marketplace: "Place de marché",
      "visual-control": "Contrôle visuel",
      memory: "Mémoire",
      notifications: "Notifications",
      security: "Sécurité",
      logs: "Journaux",
      "communication-graph": "Comms agents",
      "quota-forecast": "Prévisions quotas",
      agents: "Agents",
      connections: "Connexions",
      "vcs-worktrees": "VCS & Worktrees",
      providers: "Fournisseurs de modèles",
      settings: "Paramètres",
      setup: "Assistant d'installation",
    },
  },
  meta: {
    chat: {
      title: "Chat",
      description: "Assignez une mission, NEXUS orchestre le reste en local.",
    },
    "career-education": {
      title: "Carrière & Éducation",
      description:
        "Planification long terme, découverte multi-pistes, préparation de candidatures sur mesure et actions confirmées.",
    },
    "trading-lab": {
      title: "Trading Lab",
      description:
        "Portefeuilles fictifs, marchés de recherche et tests de risque sans argent réel.",
    },
    osint: {
      title: "Espace OSINT",
      description:
        "Enquêtes fondées sur des preuves exploitant exclusivement des sources publiques licites.",
    },
    setup: {
      title: "Assistant d'installation",
      description: "Guide pas à pas pour l'initialisation et l'accueil sur la plateforme.",
    },
    agents: {
      title: "Agents",
      description: "Capacités, disponibilité et quotas d'allocation de votre équipe IA.",
    },
    connections: {
      title: "Connexions",
      description: "Découverte des CLI d'agents locaux sans importer leurs identifiants.",
    },
    settings: {
      title: "Paramètres",
      description: "Règles persistantes du moteur multi-agents et coffre-fort.",
    },
    overview: {
      title: "Vue d'ensemble",
      description: "État opérationnel instantané de l'ensemble de la plateforme NEXUS.",
    },
    devices: {
      title: "Appareils",
      description: "Machines appairées, niveaux de confiance et politiques d'accès.",
    },
    workers: {
      title: "Workers",
      description: "Capacité d'exécution disponible pour traiter les tâches distribuées.",
    },
    tasks: {
      title: "Tâches",
      description: "File de traitement des tâches, dépendances de graphes et résultats.",
    },
    runs: {
      title: "Exécutions d'agents",
      description: "Traces d'exécution détaillées et confirmations humaines en attente.",
    },
    tools: {
      title: "Outils",
      description: "Capacités natives, ACP et navigateurs exposées aux agents.",
    },
    mcp: {
      title: "MCP",
      description: "Serveurs de contexte et outils connectés au protocole Model Context.",
    },
    browser: {
      title: "Navigateur",
      description: "Sessions Chromium locales pilotées sans clé d'API LLM externe.",
    },
    "mission-control": {
      title: "Missions ACP",
      description: "Orchestration, avancement et reprise sur incident des missions autonomes.",
    },
    memory: {
      title: "Mémoire",
      description: "Contexte vectoriel durable réinjecté dans les missions ultérieures.",
    },
    notifications: {
      title: "Notifications",
      description: "Alertes opérationnelles et événements requérant votre attention.",
    },
    security: {
      title: "Sécurité",
      description: "Journaux d'audit, secrets chiffrés et 4 frontières de confiance.",
    },
    logs: {
      title: "Journaux",
      description: "Flux de diagnostic corrélés à l'échelle de toute la plateforme.",
    },
    "dag-debugger": {
      title: "Débogueur DAG",
      description: "Inspection des graphes d'exécution multi-étapes, pause et reprise par nœud.",
    },
    "run-comparison": {
      title: "Comparaison d'exécutions",
      description: "Comparatif des temps d'exécution, consommation de tokens et coûts relatifs.",
    },
    marketplace: {
      title: "Place de marché",
      description: "Parcourez, installez, suspendez et révoquez des extensions tierces sécurisées.",
    },
    "visual-control": {
      title: "Contrôle visuel",
      description: "Aperçu temps réel de l'automatisation graphique et arrêts d'urgence.",
    },
    "communication-graph": {
      title: "Graphe de communication",
      description: "Topologie des messages inter-agents, débit et latence de messagerie.",
    },
    "quota-forecast": {
      title: "Usage & Quotas",
      description:
        "Télémétrie des jetons en temps réel, tendances de consommation et analyse des coûts.",
    },
    domotique: {
      title: "Domotique & Satellites",
      description:
        "Supervision domotique, contrôle des pièces de vie, télémétrie acoustique et flotte de satellites vocaux ESP32.",
    },
    satellites: {
      title: "Domotique & Satellites",
      description:
        "Supervision domotique, contrôle des pièces de vie, télémétrie acoustique et flotte de satellites vocaux ESP32.",
    },
    "settings-preferences": {
      title: "Préférences & Thèmes",
      description:
        "Apparence visuelle, mode clair/sombre, langue et options de l'interface bureau.",
    },
    "settings-shortcuts": {
      title: "Raccourcis clavier",
      description: "Raccourcis clavier configurables et touches de productivité.",
    },
    "settings-engine": {
      title: "Moteurs LLM & Routage",
      description:
        "Configurez les modèles locaux, les chaînes de repli et les fournisseurs d'API externes.",
    },
    "settings-secrets": {
      title: "Clés API & Secrets",
      description:
        "Identifiants chiffrés, jetons d'accès des fournisseurs et secrets d'environnement.",
    },
    "settings-backup": {
      title: "Sauvegarde & Restauration",
      description:
        "Instantanés de configuration, export de l'état et restauration de points précédents.",
    },
    "usage-limits": {
      title: "Limites & Réinitialisations",
      description:
        "Jauges de capacité, fenêtres glissantes de 5 heures et comptes à rebours hebdomadaires.",
    },
    "usage-costs": {
      title: "Répartition des coûts",
      description: "Coûts par modèle, par niveau de fournisseur et par utilisation du cache.",
    },
    "usage-tokens": {
      title: "Flux de jetons & métriques",
      description:
        "Répartition fine des jetons de prompt, de complétion et de lecture/écriture du cache.",
    },
    observability: {
      title: "Observabilité",
      description:
        "Santé des services, moteur de missions, serveurs MCP, erreurs récentes et recherche d'incidents.",
    },
    organizations: {
      title: "Organisations",
      description: "Organisations dont vous êtes membre, leurs membres et leurs rôles.",
    },
    "vcs-worktrees": {
      title: "VCS & Worktrees",
      description:
        "Gérez les worktrees Git isolés, inspectez les checkpoints par tour et reliez les pull requests.",
    },
    providers: {
      title: "Fournisseurs de modèles",
      description:
        "Supervisez les moteurs d'IA réels, la comptabilité des jetons et les runtimes actifs.",
    },
  },
  chat: {
    inputPlaceholder: "Assignez une mission, posez une question ou décrivez un objectif…",
    send: "Envoyer",
    hint: "Entrée pour envoyer, Maj+Entrée pour un saut de ligne",
    agentSelect: "Agent :",
    emptyState: "Aucun message pour l'instant. Démarrez une conversation avec NEXUS.",
    fallbackNotice: "Repli d'agent actif : routé via un modèle secondaire",
  },
  tradingLab: {
    badge: "Simulation & Recherche — Aucun fonds réel",
    disclaimer:
      "La création de missions et de portefeuilles de recherche utilise l'API administrateur NEXUS. Aucune route d'exécution financière réelle n'est exposée.",
    paperPortfolios: "Portefeuilles de recherche papier",
    portfolioName: "Nom du portefeuille",
    capitalEur: "Capital (EUR)",
    createPortfolio: "Créer le portefeuille",
    noPortfolios: "Aucun portefeuille de recherche configuré.",
    cashBalance: "Liquidités",
    openExposure: "Exposition ouverte",
    realizedPnl: "P&L Réalisé",
    mode: "Mode",
    paperMarket: "Marché de recherche papier",
    marketQuestion: "Question de marché",
    closeAt: "Date et heure de clôture",
    createMarket: "Créer le marché",
  },
  osint: {
    title: "Espace OSINT",
    description:
      "Enquêtes fondées sur des preuves exploitant exclusivement des sources publiques licites.",
    activeCases: "Dossiers d'enquête actifs",
    newInvestigation: "Nouvelle enquête",
    target: "Identifiant de la cible",
    objective: "Objectif recherché",
    lawfulConfirmation:
      "Je certifie que cette enquête porte exclusivement sur des données publiques et accessibles légalement.",
    sherlockDiscovery: "Découverte Sherlock isolée",
    runSherlock: "Lancer l'analyse Sherlock",
    evidenceGraph: "Graphe de preuves",
    reports: "Rapports d'enquête",
  },
  supervision: {
    missionControl: {
      acpEngine: "Moteur ACP",
      workers: "Workers",
      concurrency: "Concomitance",
      auditChain: "Chaîne d'audit",
      recentRuns: "Missions récentes",
      noRuns: "Aucune mission ACP exécutée.",
    },
    devices: {
      pairedDevices: "Appareils appairés",
      noDevices: "Aucun appareil appairé.",
      pairNewDevice: "Appairer un appareil",
      ticketTtl: "Le ticket expire dans 5 minutes",
      ticketLabel: "Ticket d'appairage",
      approve: "Approuver",
      revoke: "Révoquer",
    },
    browser: {
      localChromium: "Session Chromium locale",
      sandboxStatus: "Conteneurisé",
      captureScreenshot: "Capturer l'écran",
    },
    memory: {
      vectorIndex: "Index vectoriel (pgvector)",
      entities: "Entités mémorisées",
      searchMemory: "Explorer la mémoire",
    },
    quotaForecast: {
      tokenUsage: "Consommation de tokens",
      costForecast: "Prévisions de coût",
      confidence: "Intervalle de confiance",
    },
  },
  settings: {
    runtimeSettings: "Paramètres d'exécution",
    secrets: "Coffre-fort chiffré",
    llmEngines: "Moteurs LLM & Fournisseurs d'inférence",
    preferLocal: "Préférer les modèles locaux aux API distantes",
    addEngine: "Ajouter un moteur",
    testEngine: "Tester le moteur",
  },
};
