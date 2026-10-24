import type { ItemReputation, UserReview, MarketplacePublisher } from "./types.js";
import { McpSecurityError } from "../errors.js";

export class ReputationEngine {
  private reviews = new Map<string, UserReview[]>(); // itemId -> reviews
  private reports = new Map<string, number>(); // itemId -> report count
  private trustedPublishers = new Set<string>();

  constructor(trustedPublisherKeyFingerprints?: string[]) {
    if (trustedPublisherKeyFingerprints) {
      for (const fp of trustedPublisherKeyFingerprints) {
        this.trustedPublishers.add(fp);
      }
    }
  }

  addTrustedPublisher(publisher: MarketplacePublisher): void {
    this.trustedPublishers.add(publisher.keyFingerprint);
  }

  isPublisherVerified(publisher: MarketplacePublisher): boolean {
    return publisher.verified || this.trustedPublishers.has(publisher.keyFingerprint);
  }

  submitReview(review: UserReview): void {
    if (!review.verifiedInstall) {
      throw new McpSecurityError(
        review.itemId,
        "Cannot submit review without verified installation proof (Sybil defense)",
      );
    }
    if (review.rating < 1 || review.rating > 5) {
      throw new McpSecurityError(review.itemId, "Rating must be between 1 and 5");
    }

    const itemReviews = this.reviews.get(review.itemId) ?? [];
    // Replace if user already reviewed
    const existingIndex = itemReviews.findIndex((r) => r.userId === review.userId);
    if (existingIndex >= 0) {
      itemReviews[existingIndex] = review;
    } else {
      itemReviews.push(review);
    }
    this.reviews.set(review.itemId, itemReviews);
  }

  reportAbuse(itemId: string, _reason: string): void {
    const current = this.reports.get(itemId) ?? 0;
    this.reports.set(itemId, current + 1);
  }

  getReputation(itemId: string, initial?: ItemReputation): ItemReputation {
    const reviews = this.reviews.get(itemId) ?? [];
    const reportsCount = this.reports.get(itemId) ?? initial?.reportsCount ?? 0;

    const verifiedReviews = reviews.filter((r) => r.verifiedInstall);
    const reviewCount = verifiedReviews.length;

    // Bayesian weighted rating calculation
    // Prior mean m = 3.5, confidence weight C = 5
    const PRIOR_MEAN = 3.5;
    const PRIOR_WEIGHT = 5;

    let score = initial?.score ?? PRIOR_MEAN;
    if (reviewCount > 0) {
      const sumRatings = verifiedReviews.reduce((acc, r) => acc + r.rating, 0);
      score = Number(
        ((PRIOR_WEIGHT * PRIOR_MEAN + sumRatings) / (PRIOR_WEIGHT + reviewCount)).toFixed(2),
      );
    }

    // Quarantine threshold: 3 or more reports triggers automatic quarantine
    const quarantined = reportsCount >= 3 || (initial?.quarantined ?? false);

    return {
      score,
      reviewCount,
      verifiedReviews: reviewCount,
      reportsCount,
      quarantined,
    };
  }
}
