import { z } from "zod";

export const activepiecesConfigSchema = z.object({
  baseUrl: z.string().url().default("http://127.0.0.1:8080"),
  apiKeyRef: z.string().regex(/^vault:\/\/nexus\/[a-z][a-z0-9_-]{0,63}$/),
  projectId: z.string().optional(),
});
export type ActivepiecesConfig = z.infer<typeof activepiecesConfigSchema>;

export interface ActivepiecesFlow {
  id: string;
  name: string;
  status: "ENABLED" | "DISABLED";
  webhookUrl?: string | undefined;
  updatedAt?: string | undefined;
}

export interface FlowTriggerOptions {
  flowId?: string | undefined;
  webhookUrl?: string | undefined;
  payload: Record<string, unknown>;
  waitForCompletion?: boolean | undefined;
  timeoutMs?: number | undefined;
  isSensitive?: boolean | undefined;
}

export interface FlowRunResult {
  runId: string;
  flowId: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "PAUSED";
  output?: unknown;
  durationMs?: number | undefined;
  error?: string | undefined;
}

export interface PieceActionOptions {
  pieceName: string;
  actionName: string;
  input: Record<string, unknown>;
  pieceVersion?: string | undefined;
  isSensitive?: boolean | undefined;
}

export interface PieceActionResult {
  success: boolean;
  pieceName: string;
  actionName: string;
  output: unknown;
  error?: string | undefined;
}
