/**
 * NEXUS Unified VCS & Worktrees - Source Control & Pull Request Service
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import type {
  SourceControlLink,
  PullRequestReviewGuide,
  SourceControlProvider,
  ChecksState,
  ReviewState,
} from "@nexus/protocol";

export interface LinkPullRequestInput {
  provider: SourceControlProvider;
  repoUrl: string;
  branch: string;
  pullRequestNumber?: number | undefined;
  headSha?: string | undefined;
  checksState?: ChecksState | undefined;
  reviewState?: ReviewState | undefined;
  watched?: boolean | undefined;
  threadId?: string | undefined;
}

export class SourceControlService {
  private readonly links = new Map<string, SourceControlLink>();
  private readonly reviewGuides = new Map<number, PullRequestReviewGuide>();

  linkPullRequest(input: LinkPullRequestInput): SourceControlLink {
    const id = randomUUID();
    const now = new Date().toISOString();
    const link: SourceControlLink = {
      id,
      provider: input.provider,
      repoUrl: input.repoUrl,
      branch: input.branch,
      ...(input.pullRequestNumber !== undefined
        ? { pullRequestNumber: input.pullRequestNumber }
        : {}),
      ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
      checksState: input.checksState ?? "unknown",
      reviewState: input.reviewState ?? "pending",
      watched: input.watched ?? false,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.links.set(id, link);
    return link;
  }

  getLink(id: string): SourceControlLink | undefined {
    return this.links.get(id);
  }

  listLinks(threadId?: string): SourceControlLink[] {
    const all = Array.from(this.links.values());
    if (threadId) {
      return all.filter((l) => l.threadId === threadId);
    }
    return all;
  }

  unlinkPullRequest(id: string): boolean {
    return this.links.delete(id);
  }

  setWatched(id: string, watched: boolean): SourceControlLink | undefined {
    const link = this.links.get(id);
    if (!link) return undefined;
    const updated: SourceControlLink = {
      ...link,
      watched,
      updatedAt: new Date().toISOString(),
    };
    this.links.set(id, updated);
    return updated;
  }

  setReviewGuide(guide: PullRequestReviewGuide): void {
    this.reviewGuides.set(guide.prNumber, guide);
  }

  writeReviewGuide(guide: PullRequestReviewGuide): void {
    this.setReviewGuide(guide);
  }

  getReviewGuide(prNumber: number): PullRequestReviewGuide | undefined {
    return this.reviewGuides.get(prNumber);
  }

  readReviewGuide(prNumber: number): PullRequestReviewGuide | undefined {
    return this.getReviewGuide(prNumber);
  }
}
