import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { NotFoundError, ValidationError } from "@nexus/shared";
import {
  applicationStateSchema,
  careerProfileInputSchema,
  contactInputSchema,
  deadlineInputSchema,
  documentDraftInputSchema,
  followUpInputSchema,
  interviewInputSchema,
  opportunityIngestInputSchema,
  opportunityKindSchema,
  outcomeInputSchema,
  applicationView,
  confirmationView,
  contactView,
  deadlineView,
  documentSummaryView,
  documentView,
  eventView,
  followUpView,
  interviewView,
  opportunityView,
  outcomeView,
  profileView,
  submissionAttemptView,
  type ApplicationState,
  type DocumentVariantKind,
  type Opportunity,
} from "@nexus/career";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

export const careerRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── Profile ─────────────────────────────────────────────────────────────

  app.get(
    "/career/profile",
    {
      preHandler: [app.requireUser],
      schema: {
        response: {
          200: okSchema(
            z.object({
              profile: z.any().nullable(),
              completeness: z.any().nullable(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const report = await app.services.career.profile(userId);
      return ok(
        {
          profile: report.profile === null ? null : profileView(report.profile),
          completeness: report.completeness,
        },
        request.id,
      );
    },
  );

  app.put(
    "/career/profile",
    {
      preHandler: [app.requireUser],
      schema: {
        body: careerProfileInputSchema,
        response: {
          200: okSchema(
            z.object({
              profile: z.any(),
              completeness: z.any().nullable(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const report = await app.services.career.saveProfile(userId, request.body);
      return ok(
        {
          profile: report.profile === null ? null : profileView(report.profile),
          completeness: report.completeness,
        },
        request.id,
      );
    },
  );

  // Settings endpoint for dashboard compatibility
  app.get(
    "/career/settings",
    {
      preHandler: [app.requireUser],
      schema: {
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const report = await app.services.career.profile(userId);
      const prefs = report.profile?.preferences;
      return ok(
        {
          preferredLocations: prefs?.locations ?? [],
          remotePolicy: prefs?.remote ?? "no_preference",
          disciplinesAndKeywords: prefs?.mustHaveSkills ?? [],
          seniorityLevels: [],
          targetTracks: prefs?.kinds ?? [],
          currency: prefs?.minCompensation?.currency ?? "EUR",
          languages: report.profile?.languages.map((l) => l.code) ?? [],
          visaRequirement: "not_specified",
          phdTopics: prefs?.researchAreas ?? [],
          phdSupervisors: [],
          phdFundingTypes: [],
          quietHours: {
            enabled: false,
            start: "22:00",
            end: "08:00",
            timezone: "UTC",
          },
        },
        request.id,
      );
    },
  );

  app.put(
    "/career/settings",
    {
      preHandler: [app.requireUser],
      schema: {
        body: z
          .object({
            preferredLocations: z.array(z.string()).optional(),
            disciplinesAndKeywords: z.array(z.string()).optional(),
            phdTopics: z.array(z.string()).optional(),
          })
          .passthrough(),
        response: {
          200: okSchema(z.unknown()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const report = await app.services.career.profile(userId);
      if (report.profile !== null) {
        const body = request.body;
        const currentPrefs = report.profile.preferences;
        const updatedPrefs = {
          ...currentPrefs,
          ...(body.preferredLocations !== undefined ? { locations: body.preferredLocations } : {}),
          ...(body.disciplinesAndKeywords !== undefined
            ? { mustHaveSkills: body.disciplinesAndKeywords }
            : {}),
          ...(body.phdTopics !== undefined ? { researchAreas: body.phdTopics } : {}),
        };
        await app.services.career.saveProfile(userId, {
          headline: report.profile.headline,
          summary: report.profile.summary,
          yearsExperience: report.profile.yearsExperience,
          highestDegree: report.profile.highestDegree,
          skills: report.profile.skills,
          languages: report.profile.languages,
          publications: report.profile.publications,
          preferences: updatedPrefs,
        });
      }
      return ok(request.body, request.id);
    },
  );

  // ── Ingest & Opportunities ──────────────────────────────────────────────

  app.post(
    "/career/ingest",
    {
      preHandler: [app.requireUser],
      schema: {
        body: z.union([
          z.object({ items: z.array(opportunityIngestInputSchema).min(1).max(100) }),
          z.array(opportunityIngestInputSchema).min(1).max(100),
        ]),
        response: {
          200: okSchema(
            z.object({
              created: z.number(),
              merged: z.number(),
              outcomes: z.array(z.any()),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const items = Array.isArray(request.body) ? request.body : request.body.items;
      const report = await app.services.career.ingest(userId, items);
      return ok(report, request.id);
    },
  );

  app.get(
    "/career/opportunities",
    {
      preHandler: [app.requireUser],
      schema: {
        querystring: z.object({
          kind: opportunityKindSchema.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          includeExcluded: z.coerce.boolean().default(false),
        }),
        response: {
          200: okSchema(
            z.object({
              opportunities: z.array(z.any()),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const { kind, limit, includeExcluded } = request.query;

      // If user has a profile, rank opportunities
      const existingProfile = await app.services.careerStore.getProfile(userId);
      if (existingProfile !== undefined) {
        const results = await app.services.career.search(userId, {
          ...(kind !== undefined ? { kind } : {}),
          limit,
          includeExcluded,
        });
        return ok(
          {
            opportunities: results.map((r) => ({
              ...opportunityView(r.opportunity),
              matchExplanation: r.explanation,
              applicationState: r.applicationState,
            })),
          },
          request.id,
        );
      }

      // Without a profile, return raw opportunities unranked
      const raw = await app.services.careerStore.listOpportunities(userId, {
        ...(kind === undefined ? {} : { kind }),
        limit,
      });
      return ok(
        {
          opportunities: raw.map(opportunityView),
        },
        request.id,
      );
    },
  );

  app.get(
    "/career/opportunities/:id",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const opp = await app.services.careerStore.getOpportunity(userId, request.params.id);
      if (opp === undefined) {
        throw new NotFoundError({
          message: `Unknown opportunity: ${request.params.id}`,
          userMessage: "The requested resource does not exist.",
        });
      }
      return ok(opportunityView(opp), request.id);
    },
  );

  app.post(
    "/career/opportunities/:id/shortlist",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const application = await app.services.career.shortlist(userId, request.params.id);
      return ok(applicationView(application), request.id);
    },
  );

  app.post(
    "/career/opportunities/compare",
    {
      preHandler: [app.requireUser],
      schema: {
        body: z.object({
          ids: z.array(z.string().uuid()).min(1).max(10),
        }),
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const opps = await Promise.all(
        request.body.ids.map((id) => app.services.careerStore.getOpportunity(userId, id)),
      );
      const valid = opps.filter((o: Opportunity | undefined): o is Opportunity => o !== undefined);
      return ok(
        {
          items: valid.map(opportunityView),
          comparisonAttributes: ["compensation", "location", "remote", "requirements"],
        },
        request.id,
      );
    },
  );

  // ── Applications ────────────────────────────────────────────────────────

  app.get(
    "/career/applications",
    {
      preHandler: [app.requireUser],
      schema: {
        querystring: z.object({
          state: applicationStateSchema.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: {
          200: okSchema(
            z.object({
              applications: z.array(z.any()),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const applications = await app.services.careerStore.listApplications(userId, {
        ...(request.query.state === undefined ? {} : { state: request.query.state }),
        limit: request.query.limit,
      });
      return ok(
        {
          applications: applications.map(applicationView),
        },
        request.id,
      );
    },
  );

  app.post(
    "/career/applications",
    {
      preHandler: [app.requireUser],
      schema: {
        body: z.object({
          opportunityId: z.string().uuid(),
        }),
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const application = await app.services.career.shortlist(userId, request.body.opportunityId);
      return ok(applicationView(application), request.id);
    },
  );

  app.get(
    "/career/applications/:id",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const detail = await app.services.career.applicationDetail(userId, request.params.id);
      const events = await app.services.career.history(userId, request.params.id);
      return ok(
        {
          application: applicationView(detail.application),
          opportunity: opportunityView(detail.opportunity),
          documents: detail.documents.map(documentSummaryView),
          contacts: detail.contacts.map(contactView),
          deadlines: detail.deadlines.map(deadlineView),
          interviews: detail.interviews.map(interviewView),
          outcome: detail.outcome === null ? null : outcomeView(detail.outcome),
          events: events.map(eventView),
        },
        request.id,
      );
    },
  );

  app.post(
    "/career/applications/:id/drafting",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const application = await app.services.career.startDrafting(userId, request.params.id);
      return ok(applicationView(application), request.id);
    },
  );

  app.post(
    "/career/applications/:id/advance",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        body: z.object({
          to: applicationStateSchema,
          reason: z.string().max(400).optional(),
        }),
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const application = await app.services.career.advance(
        userId,
        request.params.id,
        request.body.to,
        request.body.reason ?? "Advanced via API",
      );
      return ok(applicationView(application), request.id);
    },
  );

  // Compatible stage update endpoint
  app.put(
    "/career/applications/:id/stage",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        body: z.object({
          stage: z.string(),
          note: z.string().optional(),
        }),
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const stageMap: Record<string, ApplicationState> = {
        discovered: "discovered",
        shortlisted: "shortlisted",
        preparing: "drafting",
        drafting: "drafting",
        pending_approval: "awaiting_confirmation",
        awaiting_confirmation: "awaiting_confirmation",
        approved: "approved",
        submitted: "submitted",
        interviewing: "interview",
        interview: "interview",
        offer: "offer",
        rejected: "rejected",
        withdrawn: "withdrawn",
        expired: "expired",
      };
      const targetState = stageMap[request.body.stage];
      if (targetState === undefined) {
        throw new ValidationError({
          message: `Invalid stage: ${request.body.stage}`,
          userMessage: `Unknown stage: ${request.body.stage}`,
        });
      }
      const application = await app.services.career.advance(
        userId,
        request.params.id,
        targetState,
        request.body.note ?? "Stage updated via API",
      );
      return ok(applicationView(application), request.id);
    },
  );

  // ── Documents ───────────────────────────────────────────────────────────

  app.get(
    "/career/applications/:id/documents",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        response: {
          200: okSchema(
            z.object({
              documents: z.array(z.any()),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const docs = await app.services.career.listDocuments(userId, request.params.id);
      return ok(
        {
          documents: docs.map(documentSummaryView),
        },
        request.id,
      );
    },
  );

  app.post(
    "/career/applications/:id/documents",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        body: documentDraftInputSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const doc = await app.services.career.draftDocument(userId, request.params.id, request.body);
      return ok(documentView(doc), request.id);
    },
  );

  app.get(
    "/career/documents/:id",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const doc = await app.services.career.getDocument(userId, request.params.id);
      if (doc === undefined) {
        throw new NotFoundError({
          message: `Unknown document: ${request.params.id}`,
          userMessage: "The requested resource does not exist.",
        });
      }
      return ok(documentView(doc), request.id);
    },
  );

  // Compatible tailor document endpoint
  app.post(
    "/career/documents/tailor",
    {
      preHandler: [app.requireUser],
      schema: {
        body: z.object({
          opportunityId: z.string().uuid(),
          applicationId: z.string().uuid().optional(),
          type: z.string(),
          customInstructions: z.string().optional(),
        }),
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      let applicationId = request.body.applicationId;
      if (applicationId === undefined) {
        const appRecord = await app.services.careerStore.findApplicationByOpportunity(
          userId,
          request.body.opportunityId,
        );
        if (appRecord === undefined) {
          const created = await app.services.career.shortlist(userId, request.body.opportunityId);
          applicationId = created.id;
        } else {
          applicationId = appRecord.id;
        }
      }

      const kindMap: Record<string, DocumentVariantKind> = {
        cv: "cv",
        cover_letter: "cover_letter",
        research_statement: "research_statement",
        portfolio_note: "portfolio_note",
        reference_list: "reference_list",
        rate_card: "portfolio_note",
      };
      const kind = kindMap[request.body.type] ?? "cover_letter";

      const opp = await app.services.careerStore.getOpportunity(userId, request.body.opportunityId);
      const orgName = opp?.organization ?? "the team";
      const oppTitle = opp?.title ?? "the role";
      const bodyText =
        `Tailored ${kind.replace("_", " ")} for ${oppTitle} at ${orgName}.\n${request.body.customInstructions ?? ""}`.trim();

      const doc = await app.services.career.draftDocument(userId, applicationId, {
        kind,
        body: bodyText,
        parentVariantId: null,
      });

      return ok(documentView(doc), request.id);
    },
  );

  // ── Confirmations ───────────────────────────────────────────────────────

  app.get(
    "/career/applications/:id/confirmations",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        response: {
          200: okSchema(
            z.object({
              confirmations: z.array(z.any()),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const confirmations = await app.services.career.pendingConfirmations(
        userId,
        request.params.id,
      );
      return ok(
        {
          confirmations: confirmations.map(confirmationView),
        },
        request.id,
      );
    },
  );

  app.post(
    "/career/applications/:id/approval-request",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        response: {
          200: okSchema(
            z.object({
              confirmation: z.any(),
              application: z.any(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const res = await app.services.career.requestApproval(userId, request.params.id);
      return ok(
        {
          confirmation: confirmationView(res.confirmation),
          application: applicationView(res.application),
        },
        request.id,
      );
    },
  );

  app.post(
    "/career/confirmations/:id/decide",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        body: z.object({
          decision: z.enum(["approved", "rejected", "cancelled"]),
          reason: z.string().max(400).optional(),
        }),
        response: {
          200: okSchema(
            z.object({
              confirmation: z.any(),
              application: z.any(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const res = await app.services.career.decideConfirmation(
        userId,
        request.params.id,
        request.body.decision,
        request.body.reason,
      );
      return ok(
        {
          confirmation: confirmationView(res.confirmation),
          application: applicationView(res.application),
        },
        request.id,
      );
    },
  );

  // Compatible resolve confirmation endpoint
  app.post(
    "/career/confirmations/:id/resolve",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        body: z.object({
          decision: z.enum(["approve", "reject", "cancel", "approved", "rejected", "cancelled"]),
          reason: z.string().max(400).optional(),
        }),
        response: {
          200: okSchema(
            z.object({
              confirmation: z.any(),
              application: z.any(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const map: Record<string, "approved" | "rejected" | "cancelled"> = {
        approve: "approved",
        approved: "approved",
        reject: "rejected",
        rejected: "rejected",
        cancel: "cancelled",
        cancelled: "cancelled",
      };
      const canonicalDecision = map[request.body.decision] ?? "rejected";
      const res = await app.services.career.decideConfirmation(
        userId,
        request.params.id,
        canonicalDecision,
        request.body.reason,
      );
      return ok(
        {
          confirmation: confirmationView(res.confirmation),
          application: applicationView(res.application),
        },
        request.id,
      );
    },
  );

  // ── Submissions ─────────────────────────────────────────────────────────

  app.post(
    "/career/applications/:id/submit",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        response: {
          200: okSchema(
            z.object({
              attempt: z.any(),
              replayed: z.boolean(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const result = await app.services.career.submit(userId, request.params.id);
      return ok(
        {
          attempt: submissionAttemptView(result.attempt),
          replayed: result.replayed,
        },
        request.id,
      );
    },
  );

  // ── Outcomes ────────────────────────────────────────────────────────────

  app.post(
    "/career/applications/:id/outcome",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        body: outcomeInputSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const res = await app.services.career.recordOutcome(userId, request.params.id, request.body);
      return ok(outcomeView(res.outcome), request.id);
    },
  );

  // ── Contacts ────────────────────────────────────────────────────────────

  app.post(
    "/career/applications/:id/contacts",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        body: contactInputSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const contact = await app.services.career.addContact(userId, request.body);
      return ok(contactView(contact), request.id);
    },
  );

  // ── Deadlines ───────────────────────────────────────────────────────────

  app.post(
    "/career/applications/:id/deadlines",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        body: deadlineInputSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const deadline = await app.services.career.addDeadline(
        userId,
        request.params.id,
        request.body,
      );
      return ok(deadlineView(deadline), request.id);
    },
  );

  // ── Interviews ──────────────────────────────────────────────────────────

  app.post(
    "/career/applications/:id/interviews",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        body: interviewInputSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const res = await app.services.career.scheduleInterview(
        userId,
        request.params.id,
        request.body,
      );
      return ok(interviewView(res.interview), request.id);
    },
  );

  // ── Follow-ups ──────────────────────────────────────────────────────────

  app.post(
    "/career/applications/:id/follow-ups",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        body: followUpInputSchema,
        response: {
          200: okSchema(z.any()),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const followUp = await app.services.career.planFollowUp(
        userId,
        request.params.id,
        request.body,
      );
      return ok(followUpView(followUp), request.id);
    },
  );

  // ── Events & Audit ──────────────────────────────────────────────────────

  app.get(
    "/career/applications/:id/events",
    {
      preHandler: [app.requireUser],
      schema: {
        params: idParamsSchema,
        response: {
          200: okSchema(
            z.object({
              events: z.array(z.any()),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const events = await app.services.career.history(userId, request.params.id);
      return ok(
        {
          events: events.map(eventView),
        },
        request.id,
      );
    },
  );

  // ── Sweep expired ───────────────────────────────────────────────────────

  app.post(
    "/career/sweep-expired",
    {
      preHandler: [app.requireUser],
      schema: {
        response: {
          200: okSchema(
            z.object({
              expiredCount: z.number(),
              applications: z.array(z.any()),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const expired = await app.services.career.sweepExpired(userId);
      return ok(
        {
          expiredCount: expired.length,
          applications: expired.map(applicationView),
        },
        request.id,
      );
    },
  );

  done();
};
