/**
 * NEXUS Transactional Orchestration - Transactional Inbox & Idempotency
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { uuidv7 } from "@nexus/shared";

export type InboxStatus = "received" | "processing" | "completed" | "failed" | "duplicate";

export interface CommandReceipt<TResult = unknown> {
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly status: "completed" | "failed";
  readonly result?: TResult | undefined;
  readonly error?: string | undefined;
  readonly executedAt: string;
}

export interface TransactionalInboxMessage<TPayload = unknown> {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly payload: TPayload;
  readonly receivedAt: string;
  readonly processedAt?: string | undefined;
  readonly status: InboxStatus;
  readonly receipt?: CommandReceipt | undefined;
}

export interface ReceiveCommandInput<TPayload = unknown> {
  idempotencyKey: string;
  commandType: string;
  payload: TPayload;
}

export interface ReceiveCommandResult<TResult = unknown> {
  duplicate: boolean;
  messageId: string;
  existingReceipt?: CommandReceipt<TResult> | undefined;
}

export interface TransactionalInbox {
  receive<TPayload, TResult>(
    input: ReceiveCommandInput<TPayload>,
  ): Promise<ReceiveCommandResult<TResult>>;
  recordReceipt<TResult>(
    idempotencyKey: string,
    outcome: { status: "completed" | "failed"; result?: TResult; error?: string },
  ): Promise<CommandReceipt<TResult>>;
  getReceipt<TResult>(idempotencyKey: string): Promise<CommandReceipt<TResult> | undefined>;
}

export class InMemoryTransactionalInbox implements TransactionalInbox {
  private readonly messages = new Map<string, TransactionalInboxMessage>();
  private readonly receipts = new Map<string, CommandReceipt>();

  async receive<TPayload, TResult>(
    input: ReceiveCommandInput<TPayload>,
  ): Promise<ReceiveCommandResult<TResult>> {
    await Promise.resolve();
    const existing = this.messages.get(input.idempotencyKey);
    if (existing) {
      const receipt = this.receipts.get(input.idempotencyKey) as
        CommandReceipt<TResult> | undefined;
      return {
        duplicate: true,
        messageId: existing.id,
        existingReceipt: receipt,
      };
    }

    const id = uuidv7();
    const msg: TransactionalInboxMessage = {
      id,
      idempotencyKey: input.idempotencyKey,
      commandType: input.commandType,
      payload: input.payload,
      receivedAt: new Date().toISOString(),
      status: "processing",
    };

    this.messages.set(input.idempotencyKey, msg);
    return {
      duplicate: false,
      messageId: id,
    };
  }

  async recordReceipt<TResult>(
    idempotencyKey: string,
    outcome: { status: "completed" | "failed"; result?: TResult; error?: string },
  ): Promise<CommandReceipt<TResult>> {
    await Promise.resolve();
    const existingMsg = this.messages.get(idempotencyKey);
    const now = new Date().toISOString();

    const receipt: CommandReceipt<TResult> = {
      idempotencyKey,
      commandType: existingMsg?.commandType ?? "unknown",
      status: outcome.status,
      result: outcome.result,
      error: outcome.error,
      executedAt: now,
    };

    this.receipts.set(idempotencyKey, receipt);

    if (existingMsg) {
      this.messages.set(idempotencyKey, {
        ...existingMsg,
        status: outcome.status,
        processedAt: now,
        receipt,
      });
    }

    return receipt;
  }

  async getReceipt<TResult>(idempotencyKey: string): Promise<CommandReceipt<TResult> | undefined> {
    await Promise.resolve();
    return this.receipts.get(idempotencyKey) as CommandReceipt<TResult> | undefined;
  }
}
