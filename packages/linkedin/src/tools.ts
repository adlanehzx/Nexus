import { z } from "zod";
import type { ToolDefinition, ToolContext } from "@nexus/tools";
import type { LinkedInClient } from "./client.js";
import { linkedInMutationResultSchema, linkedInProfileSchema } from "./types.js";

const publishSchema = z.object({
  authorUrn: z.string().regex(/^urn:li:person:[A-Za-z0-9_-]+$/),
  text: z.string().trim().min(1).max(3000),
  visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
});

const commentSchema = z.object({
  actorUrn: z.string().regex(/^urn:li:person:[A-Za-z0-9_-]+$/),
  postUrn: z.string().regex(/^urn:li:(share|ugcPost):[A-Za-z0-9_-]+$/),
  text: z.string().trim().min(1).max(1250),
});

export function createLinkedInTools(input: {
  client: LinkedInClient;
}): ToolDefinition<never, unknown>[] {
  const profile: ToolDefinition<Record<string, never>, z.infer<typeof linkedInProfileSchema>> = {
    name: "linkedin.profile.read",
    version: "1.0.0",
    description:
      "Reads the authenticated member's basic LinkedIn profile through the official API.",
    inputSchema: z.object({}),
    outputSchema: linkedInProfileSchema,
    riskLevel: "SAFE",
    requiredPermissions: ["linkedin.profile.read"],
    requiresConfirmation: false,
    execute: (_value, context) => input.client.getProfile(context.signal),
  };
  const publish: ToolDefinition<
    z.infer<typeof publishSchema>,
    z.infer<typeof linkedInMutationResultSchema>
  > = {
    name: "linkedin.post.publish",
    version: "1.0.0",
    description:
      "Publishes a member post through LinkedIn's official API after explicit confirmation.",
    inputSchema: publishSchema,
    outputSchema: linkedInMutationResultSchema,
    riskLevel: "HIGH",
    requiredPermissions: ["linkedin.social.write"],
    requiresConfirmation: true,
    idempotent: false,
    summarize: (value) =>
      `Publish LinkedIn post (${value.visibility}): ${value.text.slice(0, 120)}`,
    execute: (value, context: ToolContext) =>
      input.client.createTextPost({ ...value, signal: context.signal }),
  };
  const comment: ToolDefinition<
    z.infer<typeof commentSchema>,
    z.infer<typeof linkedInMutationResultSchema>
  > = {
    name: "linkedin.comment.publish",
    version: "1.0.0",
    description: "Publishes a comment through LinkedIn's official API after explicit confirmation.",
    inputSchema: commentSchema,
    outputSchema: linkedInMutationResultSchema,
    riskLevel: "HIGH",
    requiredPermissions: ["linkedin.social.write"],
    requiresConfirmation: true,
    idempotent: false,
    summarize: (value) => `Comment on LinkedIn post ${value.postUrn}: ${value.text.slice(0, 120)}`,
    execute: (value, context: ToolContext) =>
      input.client.createComment({ ...value, signal: context.signal }),
  };
  return [profile, publish, comment] as unknown as ToolDefinition<never, unknown>[];
}
