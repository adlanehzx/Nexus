import { createHash } from "node:crypto";
import type { OpportunityKind } from "./vocabulary.js";

/**
 * Identity, deduplication and idempotency — all three from one hash function.
 *
 * ## Why deduplication has to be conservative
 *
 * The same doctoral position is published on the university site, mirrored by a
 * funder registry and scraped by two aggregators. Four records for one position
 * means four applications, and the failure mode is not cosmetic: it is sending
 * the same cover letter twice to the same professor.
 *
 * The opposite error is worse in a subtler way. Two genuinely different posts
 * at the same institution — "PhD in distributed systems" and "PhD in
 * cryptography" — merged into one means one of them is silently lost, and
 * nothing in the interface will ever say so. So the fingerprint includes the
 * *title*, and normalisation stops well short of stemming: it folds case,
 * accents, punctuation and whitespace, and nothing else. Two listings merge
 * only when they are the same posting written by the same hand, or when their
 * canonical URLs agree.
 *
 * ## Why the keys are derived rather than random
 *
 * `submissionIdempotencyKey` is a hash of what is being submitted, not a UUID
 * minted at the start of the attempt. A random key makes a retry a *new*
 * attempt, which is exactly wrong when the first attempt crashed after the
 * adapter accepted it. A derived key makes the retry collide with the row the
 * crashed attempt already wrote, and the database's unique index — not
 * application logic, which was not running — refuses the second submission.
 */

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Folds a human string to its comparison form.
 *
 * Decomposes to NFKD and drops combining marks, so precomposed and decomposed
 * "Universite" agree; folds case; drops everything that is not a letter,
 * a digit or a space; collapses runs of space. Deliberately not a stemmer and
 * deliberately not language-aware: both would merge listings that differ.
 */
export function normalizeForComparison(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface FingerprintInput {
  kind: OpportunityKind;
  title: string;
  organization: string;
  /** Empty string when the source states no location. */
  location: string;
  /** Source-side identifier, when the source provides one. */
  externalRef: string | null;
}

/**
 * Content fingerprint of an opportunity.
 *
 * Scoped by nothing — the owner scope lives in the unique index, not in the
 * hash, so the same posting discovered by two users has the same fingerprint
 * and still cannot leak between them.
 *
 * When the source supplies its own identifier, it joins the hash rather than
 * replacing it. Two aggregators both claiming `REF-1` for different posts would
 * otherwise collide, and an identifier chosen by an untrusted source must never
 * be the sole thing that decides identity.
 */
export function opportunityFingerprint(input: FingerprintInput): string {
  const parts = [
    input.kind,
    normalizeForComparison(input.title),
    normalizeForComparison(input.organization),
    normalizeForComparison(input.location),
    input.externalRef === null ? "" : normalizeForComparison(input.externalRef),
  ];
  return sha256(parts.join("\0"));
}

/** SHA-256 of a document body. Identity for approval binding. */
export function contentHash(body: string): string {
  return sha256(body);
}

/**
 * Hash of the exact payload an adapter will receive.
 *
 * Covers the opportunity, the ordered set of document variants and the contact,
 * so any edit to any of them invalidates an approval that was granted for the
 * previous version. Variant hashes are sorted before hashing: the payload's
 * meaning does not depend on the order documents were drafted in, and a
 * re-draft that changes nothing must not force a re-approval.
 */
export function submissionPayloadHash(input: {
  opportunityFingerprint: string;
  documentHashes: readonly string[];
  contactEmailHash: string | null;
}): string {
  const documents = [...input.documentHashes].sort();
  return sha256(
    [input.opportunityFingerprint, documents.join(","), input.contactEmailHash ?? ""].join("\0"),
  );
}

/**
 * Durable idempotency key for one submission.
 *
 * The approval identifier is part of it: two separate approvals of an identical
 * payload are two separate authorisations, and collapsing them would mean a
 * second approval could never be acted on.
 */
export function submissionIdempotencyKey(input: {
  applicationId: string;
  payloadHash: string;
  confirmationId: string;
}): string {
  return sha256([input.applicationId, input.payloadHash, input.confirmationId].join("\0"));
}

/**
 * One-way hash of a contact address.
 *
 * Lets the payload hash depend on *which* person is being written to without
 * copying their address into a submission attempt row, an audit event or a log
 * line. The address itself stays in exactly one table.
 */
export function contactEmailHash(email: string): string {
  return sha256(email.trim().toLowerCase());
}
