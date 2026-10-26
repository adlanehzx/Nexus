import { z } from "zod";

export const LINKEDIN_SCOPES = ["openid", "profile", "email", "w_member_social"] as const;

export const linkedInTokensSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
  scope: z.string().optional(),
});

export type LinkedInTokens = z.infer<typeof linkedInTokensSchema>;

export const linkedInProfileSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  givenName: z.string().optional(),
  familyName: z.string().optional(),
  picture: z.string().url().optional(),
  email: z.string().email().optional(),
});

export type LinkedInProfile = z.infer<typeof linkedInProfileSchema>;

export const linkedInMutationResultSchema = z.object({
  id: z.string().min(1),
  created: z.literal(true),
});

export type LinkedInMutationResult = z.infer<typeof linkedInMutationResultSchema>;
