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
    // Enforce strict sandbox policy: allow-scripts, allow-forms, forbid allow-same-origin, allow-top-navigation
    const sandboxAttributes = ["allow-scripts", "allow-forms"];

    // Validate and sanitize custom CSP directives against injection
    const safeCustomCsp: string[] = [];
    if (Array.isArray(descriptor.cspPolicies)) {
      for (const policy of descriptor.cspPolicies) {
        const cleaned = policy.trim().replace(/;/g, "");
        const lower = cleaned.toLowerCase();
        // Prevent overriding core security boundaries
        if (
          lower.startsWith("object-src") ||
          lower.startsWith("base-uri") ||
          lower.startsWith("default-src")
        ) {
          continue;
        }
        if (cleaned.length > 0) {
          safeCustomCsp.push(cleaned);
        }
      }
    }

    const cspDirectives = [
      "default-src 'self' data: blob:",
      "script-src 'unsafe-inline' 'self'",
      "style-src 'unsafe-inline' 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      ...safeCustomCsp,
    ];

    const contentSecurityPolicy = cspDirectives.join("; ");

    // SEC-06: Sanitize HTML against base redirection, clickjacking, and plugin tags
    const sanitizedHtml = descriptor.entryHtml
      .replace(/<base\b[^>]*>/gi, "")
      .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(?:refresh|set-cookie)["']?[^>]*>/gi, "")
      .replace(/<iframe\b[^>]*>([\s\S]*?<\/iframe>)?/gi, "")
      .replace(/<object\b[^>]*>([\s\S]*?<\/object>)?/gi, "")
      .replace(/<embed\b[^>]*>/gi, "");

    return {
      appId: descriptor.appId,
      sanitizedHtml,
      contentSecurityPolicy,
      sandboxAttributes,
    };
  }
}
