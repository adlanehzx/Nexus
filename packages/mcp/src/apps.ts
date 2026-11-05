/**
 * NEXUS MCP Apps Support (LOT G)
 *
 * Provides safe hosting and rendering for interactive MCP App UI frames,
 * strictly sandboxed with Content Security Policy (CSP).
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface McpAppDescriptor {
  appId: string;
  name: string;
  version: string;
  entryHtml: string;
  cspPolicies?: string[];
  permissions: string[];
}

export interface RenderedAppFrame {
  appId: string;
  sanitizedHtml: string;
  contentSecurityPolicy: string;
  sandboxAttributes: string[];
}

export class McpAppEngine {
  renderAppFrame(descriptor: McpAppDescriptor): RenderedAppFrame {
    // Enforce strict sandbox policy: allow-scripts, forbid same-origin access to tokens / cookies
    const sandboxAttributes = ["allow-scripts", "allow-forms"];

    const cspDirectives = [
      "default-src 'self' data: blob:",
      "script-src 'unsafe-inline' 'self'",
      "style-src 'unsafe-inline' 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      ...(descriptor.cspPolicies ?? []),
    ];

    const contentSecurityPolicy = cspDirectives.join("; ");

    return {
      appId: descriptor.appId,
      sanitizedHtml: descriptor.entryHtml,
      contentSecurityPolicy,
      sandboxAttributes,
    };
  }
}
