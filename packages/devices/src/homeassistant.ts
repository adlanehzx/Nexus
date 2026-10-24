import { AppError } from "@nexus/shared";

/**
 * Home Assistant device and entity bridge.
 *
 * ## Principles
 * 1. Read and Write operations are strictly separated.
 * 2. `homeassistant.read` grants query access to entity state, history, and attributes.
 * 3. `homeassistant.write` is required to call services or mutate device states (switches, lights, thermostats).
 * 4. All write mutations produce a permanent audit log recording caller, target entity, and change diff.
 */

export interface HomeAssistantEntityState {
  readonly entityId: string;
  readonly state: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly lastChanged: string;
}

export interface HomeAssistantServiceCall {
  readonly domain: string;
  readonly service: string;
  readonly targetEntityId: string;
  readonly serviceData?: Readonly<Record<string, unknown>> | undefined;
}

export interface HomeAssistantMutationAuditEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly initiator: string;
  readonly serviceCall: HomeAssistantServiceCall;
  readonly success: boolean;
  readonly previousState?: string | undefined;
  readonly newState?: string | undefined;
  readonly error?: string | undefined;
}

export class HomeAssistantPermissionDeniedError extends AppError {
  readonly code = "HOMEASSISTANT_PERMISSION_DENIED";
  readonly httpStatus = 403;

  constructor(operation: "read" | "write", requiredPermission: string) {
    super({
      message: `Home Assistant ${operation} operation denied. Missing permission: ${requiredPermission}`,
      userMessage: `Home automation action rejected: your account lacks '${requiredPermission}' authorization.`,
      context: { operation, requiredPermission },
    });
  }
}

export interface HomeAssistantClientAdapter {
  getState(entityId: string): Promise<HomeAssistantEntityState | undefined>;
  callService(call: HomeAssistantServiceCall): Promise<{ success: boolean; newState?: string }>;
}

export class HomeAssistantBridge {
  readonly #adapter: HomeAssistantClientAdapter;
  readonly #auditLog: HomeAssistantMutationAuditEvent[] = [];

  constructor(adapter: HomeAssistantClientAdapter) {
    this.#adapter = adapter;
  }

  /**
   * Reads state of an entity. Requires `homeassistant.read` or wildcard permission.
   */
  async readEntity(
    entityId: string,
    permissions: readonly string[],
  ): Promise<HomeAssistantEntityState | undefined> {
    const hasRead =
      permissions.includes("homeassistant.read") ||
      permissions.includes("homeassistant.*") ||
      permissions.includes("*");

    if (!hasRead) {
      throw new HomeAssistantPermissionDeniedError("read", "homeassistant.read");
    }

    return this.#adapter.getState(entityId);
  }

  /**
   * Calls a mutation service. Requires `homeassistant.write` or wildcard permission.
   * Emits audit log event.
   */
  async executeWriteAction(
    call: HomeAssistantServiceCall,
    permissions: readonly string[],
    initiator: string,
  ): Promise<{ success: boolean; newState?: string | undefined }> {
    const hasWrite =
      permissions.includes("homeassistant.write") ||
      permissions.includes("homeassistant.*") ||
      permissions.includes("*");

    if (!hasWrite) {
      this.#recordAudit(
        initiator,
        call,
        false,
        undefined,
        undefined,
        "Missing homeassistant.write",
      );
      throw new HomeAssistantPermissionDeniedError("write", "homeassistant.write");
    }

    // Capture previous state for mutation diff
    const prev = await this.#adapter.getState(call.targetEntityId);
    const previousState = prev?.state;

    try {
      const outcome = await this.#adapter.callService(call);
      this.#recordAudit(initiator, call, outcome.success, previousState, outcome.newState);
      return outcome;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.#recordAudit(initiator, call, false, previousState, undefined, errorMsg);
      throw err;
    }
  }

  getAuditLog(): readonly HomeAssistantMutationAuditEvent[] {
    return this.#auditLog;
  }

  #recordAudit(
    initiator: string,
    call: HomeAssistantServiceCall,
    success: boolean,
    previousState?: string,
    newState?: string,
    error?: string,
  ): void {
    this.#auditLog.push({
      id: `haaudit_${Math.random().toString(36).slice(2, 10)}`,
      timestamp: Date.now(),
      initiator,
      serviceCall: call,
      success,
      ...(previousState !== undefined ? { previousState } : {}),
      ...(newState !== undefined ? { newState } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }
}
