import { createHash } from "node:crypto";
import { ConfigurationError } from "@nexus/shared";
import type { DocumentVariantKind, OpportunityKind } from "@nexus/career";

/**
 * The boundary where a submission would leave the machine.
 *
 * ## What the port deliberately does not carry
 *
 * A payload handed to an adapter contains **no document body and no address**.
 * It carries kinds, content hashes, lengths and a one-way hash of the
 * recipient. That is enough to identify what was approved, to produce a
 * receipt, and to prove after the fact that what was sent is what was approved
 * — and it is not enough for a registered adapter to exfiltrate anything.
 *
 * This is a real constraint on a future real adapter, not an oversight. An
 * adapter that genuinely needs to upload a CV has to be given that capability
 * explicitly, through a design review that can ask why; it cannot acquire it by
 * being plugged into this interface. The alternative — passing everything and
 * trusting the implementation — means the first third-party adapter silently
 * gains read access to the owner's whole correspondence.
 *
 * ## No real adapter exists, and that is the default
 *
 * `RecordingSubmissionAdapter` is what the container mounts. It writes nothing
 * outside the process, opens no socket, and returns a receipt derived from the
 * payload. Nothing in this repository sends an email, fills a form, creates an
 * account or writes to a calendar, and `RefusingSubmissionAdapter` is what a
 * deployment gets if it names an adapter that has not been built: a refusal,
 * not a fallback to something that looks like it worked.
 */

export interface SubmissionPayload {
  applicationId: string;
  opportunity: {
    kind: OpportunityKind;
    title: string;
    organization: string;
    /** Where a real adapter would go. Never fetched here. */
    canonicalUrl: string | null;
  };
  /** Content identity only. No bodies cross this boundary. */
  documents: { kind: DocumentVariantKind; contentHash: string; length: number }[];
  /** One-way hash of the recipient address, or `null`. Never the address. */
  recipientHash: string | null;
  /** Hash of everything above. Equal to the approved hash, by construction. */
  payloadHash: string;
}

export interface SubmissionReceipt {
  /** Which adapter produced it. Recorded on the attempt. */
  adapter: string;
  /** Opaque reference, safe to display and to store. */
  reference: string;
}

export interface SubmissionAdapter {
  readonly name: string;
  /**
   * Whether this adapter touches anything outside the process.
   *
   * Read by the service before every call and recorded in the audit event, so
   * "nothing left the machine" is a claim backed by the adapter's own
   * declaration rather than by a reader's assumption about its name.
   */
  readonly performsExternalSideEffects: boolean;
  submit(payload: SubmissionPayload): Promise<SubmissionReceipt>;
}

/**
 * The default adapter: it records, and that is all.
 *
 * The reference is derived from the payload hash rather than random, so a test
 * can assert *which* payload produced a receipt, and a reader of the attempt
 * table can tell two submissions apart without consulting anything else.
 */
export class RecordingSubmissionAdapter implements SubmissionAdapter {
  readonly name = "recording";
  readonly performsExternalSideEffects = false;

  readonly #calls: SubmissionPayload[] = [];

  /** Every payload seen, in order. The call count is the exactly-once proof. */
  get calls(): readonly SubmissionPayload[] {
    return this.#calls;
  }

  submit(payload: SubmissionPayload): Promise<SubmissionReceipt> {
    this.#calls.push(payload);
    const reference = createHash("sha256")
      .update(`recording:${payload.payloadHash}`, "utf8")
      .digest("hex")
      .slice(0, 32);
    return Promise.resolve({ adapter: this.name, reference });
  }
}

/**
 * An adapter that was configured but does not exist.
 *
 * Fails closed on every call. The failure names the configuration key, because
 * the person who set it is the person who needs to read the message, and
 * "submission failed" would send them to the wrong place.
 */
export class RefusingSubmissionAdapter implements SubmissionAdapter {
  readonly performsExternalSideEffects = false;
  readonly name: string;
  readonly #reason: string;

  constructor(name: string, reason: string) {
    this.name = name;
    this.#reason = reason;
  }

  submit(): Promise<SubmissionReceipt> {
    return Promise.reject(
      new ConfigurationError({
        message: `Submission adapter "${this.name}" is not available: ${this.#reason}`,
        userMessage:
          "Automatic submission is not available on this installation. " +
          "The approved documents are ready to send by hand.",
        context: { adapter: this.name },
      }),
    );
  }
}
