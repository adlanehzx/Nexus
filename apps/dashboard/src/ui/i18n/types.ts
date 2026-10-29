export type Locale = "en" | "fr";

export interface Translations {
  common: {
    appName: string;
    workspace: string;
    supervision: string;
    system: string;
    actions: {
      save: string;
      saving: string;
      cancel: string;
      create: string;
      delete: string;
      edit: string;
      refresh: string;
      filter: string;
      search: string;
      copy: string;
      copied: string;
      pause: string;
      resume: string;
      test: string;
      disconnect: string;
      close: string;
      back: string;
      confirm: string;
    };
    states: {
      active: string;
      stopped: string;
      idle: string;
      running: string;
      healthy: string;
      degraded: string;
      down: string;
      valid: string;
      invalid: string;
      connected: string;
      pending: string;
      succeeded: string;
      failed: string;
      offline: string;
      online: string;
      paperOnly: string;
    };
    messages: {
      noData: string;
      restoringSession: string;
      connecting: string;
      liveApi: string;
      apiUnreachable: string;
      themeToggle: string;
      languageToggle: string;
      systemPauseNotice: string;
    };
  };
  nav: {
    groups: {
      workspaces: string;
      supervision: string;
      control: string;
      infrastructure: string;
      governance: string;
      system: string;
    };
    items: Record<string, string>;
  };
  meta: Record<string, { title: string; description: string }>;
  chat: {
    inputPlaceholder: string;
    send: string;
    hint: string;
    agentSelect: string;
    emptyState: string;
    fallbackNotice: string;
  };
  tradingLab: {
    badge: string;
    disclaimer: string;
    paperPortfolios: string;
    portfolioName: string;
    capitalEur: string;
    createPortfolio: string;
    noPortfolios: string;
    cashBalance: string;
    openExposure: string;
    realizedPnl: string;
    mode: string;
    paperMarket: string;
    marketQuestion: string;
    closeAt: string;
    createMarket: string;
  };
  osint: {
    title: string;
    description: string;
    activeCases: string;
    newInvestigation: string;
    target: string;
    objective: string;
    lawfulConfirmation: string;
    sherlockDiscovery: string;
    runSherlock: string;
    evidenceGraph: string;
    reports: string;
  };
  supervision: {
    missionControl: {
      acpEngine: string;
      workers: string;
      concurrency: string;
      auditChain: string;
      recentRuns: string;
      noRuns: string;
    };
    devices: {
      pairedDevices: string;
      noDevices: string;
      pairNewDevice: string;
      ticketTtl: string;
      ticketLabel: string;
      approve: string;
      revoke: string;
    };
    browser: {
      localChromium: string;
      sandboxStatus: string;
      captureScreenshot: string;
    };
    memory: {
      vectorIndex: string;
      entities: string;
      searchMemory: string;
    };
    quotaForecast: {
      tokenUsage: string;
      costForecast: string;
      confidence: string;
    };
  };
  settings: {
    runtimeSettings: string;
    secrets: string;
    llmEngines: string;
    preferLocal: string;
    addEngine: string;
    testEngine: string;
  };
}
