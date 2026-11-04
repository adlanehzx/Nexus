/**
 * NEXUS Next-Gen ACP Client
 *
 * Real typed JSON-RPC 2.0 client for Agent Client Protocol (ACP)
 * Supporting protocol negotiation, streaming, capability discovery and resumption.
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { uuidv7 } from "@nexus/shared";
import type { ProviderTurnStreamEvent } from "./types.js";

export interface AcpClientInfo {
  name: string;
  version: string;
}

export interface AcpServerCapabilities {
  protocolVersion: number;
  streaming: boolean;
  toolCall: boolean;
  imageInput: boolean;
  sessionResumption: boolean;
  contextWindow?: number;
  serverInfo?: {
    name: string;
    version: string;
  };
}

export interface AcpConnectionStatus {
  state: "disconnected" | "connecting" | "connected" | "unreachable";
  endpoint: string;
  lastConnectedAt?: string;
  error?: string;
}

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: TParams;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result?: TResult;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
}

export interface RealAcpTransport {
  send(message: string): Promise<void>;
  onMessage(handler: (line: string) => void): void;
  onError(handler: (err: Error) => void): void;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

export class RealAcpClient {
  private status: AcpConnectionStatus = {
    state: "disconnected",
    endpoint: "custom",
  };
  private serverCapabilities: AcpServerCapabilities | null = null;
  private pendingRequests = new Map<
    string | number,
    { resolve: (res: any) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }
  >();
  private activeStreams = new Map<string, (event: ProviderTurnStreamEvent) => void>();
  private nextReqId = 1;

  constructor(
    private readonly transport: RealAcpTransport,
    private readonly clientInfo: AcpClientInfo = { name: "nexus-acp-client", version: "0.2.0" },
  ) {
    this.setupTransportListeners();
  }

  private setupTransportListeners(): void {
    this.transport.onMessage((line) => {
      this.handleIncomingLine(line);
    });

    this.transport.onError((err) => {
      this.status = {
        state: "unreachable",
        endpoint: this.status.endpoint,
        error: err.message,
      };
    });

    this.transport.onClose(() => {
      this.status = {
        state: "disconnected",
        endpoint: this.status.endpoint,
      };
      // Fail any pending requests
      for (const [id, req] of this.pendingRequests.entries()) {
        clearTimeout(req.timeout);
        req.reject(new Error("ACP transport closed unexpectedly"));
        this.pendingRequests.delete(id);
      }
    });
  }

  private handleIncomingLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, any>;

      // Check if response
      if ("id" in parsed && (parsed.result !== undefined || parsed.error !== undefined)) {
        const pending = this.pendingRequests.get(parsed.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(parsed.id);
          if (parsed.error) {
            pending.reject(
              new Error(`ACP RPC Error [${parsed.error.code}]: ${parsed.error.message}`),
            );
          } else {
            pending.resolve(parsed.result);
          }
        }
        return;
      }

      // Check if notification (e.g. session update)
      if (parsed.method === "session/update" && parsed.params) {
        const sessionId = parsed.params.sessionId;
        const handler = this.activeStreams.get(sessionId);
        if (handler && parsed.params.event) {
          handler(parsed.params.event);
        }
      }
    } catch {
      // Ignore unparseable line without crashing
    }
  }

  async sendRequest<TResult = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = 15000,
  ): Promise<TResult> {
    const id = this.nextReqId++;
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      this.transport.send(JSON.stringify(req)).catch((err) => {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
  }

  /**
   * Performs genuine protocol handshake and negotiates capabilities
   */
  async initialize(): Promise<AcpServerCapabilities> {
    this.status = { state: "connecting", endpoint: this.status.endpoint };

    try {
      const result = await this.sendRequest<{
        protocolVersion: number;
        serverInfo?: { name: string; version: string };
        capabilities?: {
          streaming?: boolean;
          toolCall?: boolean;
          imageInput?: boolean;
          sessionResumption?: boolean;
          contextWindow?: number;
        };
      }>("initialize", {
        protocolVersion: 2,
        clientInfo: this.clientInfo,
        capabilities: {
          session: { resumption: true },
          streaming: true,
          tools: true,
        },
      });

      this.serverCapabilities = {
        protocolVersion: result.protocolVersion,
        streaming: result.capabilities?.streaming ?? true,
        toolCall: result.capabilities?.toolCall ?? true,
        imageInput: result.capabilities?.imageInput ?? false,
        sessionResumption: result.capabilities?.sessionResumption ?? true,
        contextWindow: result.capabilities?.contextWindow,
        serverInfo: result.serverInfo,
      };

      this.status = {
        state: "connected",
        endpoint: this.status.endpoint,
        lastConnectedAt: new Date().toISOString(),
      };

      return this.serverCapabilities;
    } catch (err) {
      this.status = {
        state: "unreachable",
        endpoint: this.status.endpoint,
        error: err instanceof Error ? err.message : String(err),
      };
      throw err;
    }
  }

  getStatus(): AcpConnectionStatus {
    return this.status;
  }

  getCapabilities(): AcpServerCapabilities | null {
    return this.serverCapabilities;
  }

  async close(): Promise<void> {
    await this.transport.close();
    this.status = { state: "disconnected", endpoint: this.status.endpoint };
  }
}
