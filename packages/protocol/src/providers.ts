/**
 * NEXUS Unified Protocol - Provider & Model Configuration Schemas
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";

export const ProviderTypeSchema = z.enum([
  "acp",
  "codex",
  "claude",
  "cursor",
  "grok",
  "opencode",
  "fx",
  "kiro",
  "pi",
  "openai",
  "anthropic",
  "ollama",
  "freelm",
]);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const ProviderCapabilitiesSchema = z.object({
  streaming: z.boolean().default(true),
  toolCall: z.boolean().default(true),
  imageInput: z.boolean().default(false),
  audioInput: z.boolean().default(false),
  contextHandoff: z.boolean().default(true),
  checkpointRollback: z.boolean().default(true),
  maxTokens: z.number().int().positive().optional(),
  contextWindow: z.number().int().positive().optional(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ModelSelectionSchema = z.object({
  provider: ProviderTypeSchema,
  modelId: z.string().min(1),
  displayName: z.string().optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "none"]).optional().default("medium"),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  contextWindowTokens: z.number().int().positive().optional(),
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const ModelDescriptorSchema = z.object({
  id: z.string(),
  provider: ProviderTypeSchema,
  displayName: z.string(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  supportsStreaming: z.boolean(),
  supportsToolCalling: z.boolean(),
  supportsImages: z.boolean(),
  isDefault: z.boolean().optional(),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

export const AgentProviderConfigSchema = z.object({
  id: z.string().uuid(),
  providerType: ProviderTypeSchema,
  modelId: z.string().min(1),
  displayName: z.string().optional(),
  isDefault: z.boolean().default(false),
  authSecretRef: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentProviderConfig = z.infer<typeof AgentProviderConfigSchema>;

export const HandoffBudgetSchema = z.object({
  maxTurnSteps: z.number().int().positive().default(25),
  maxContextTokens: z.number().int().positive().default(128000),
  timeoutMs: z.number().int().positive().default(300000),
  costLimitUsd: z.number().positive().optional(),
});
export type HandoffBudget = z.infer<typeof HandoffBudgetSchema>;
