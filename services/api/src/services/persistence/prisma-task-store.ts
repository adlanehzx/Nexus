import type { PrismaClient } from "@nexus/database";
import type { TaskStore } from "@nexus/devices";
import type { TaskPlan, TaskExecution } from "@nexus/devices";
import {
  dateOrNull,
  executionFromRow,
  jsonOrNull,
  planFromRow,
  planStatusToDb,
  stepStatusToDb,
  stepToRow,
} from "./task-mapping.js";

/**
 * Task plan store on PostgreSQL.
 *
 * All conversions between the domain and database columns go through
 * `task-mapping.ts`. They are not cosmetic: statuses change casing,
 * dates change types, and one field changes name. Doing them ad hoc in each
 * query is what previously left this store broken without anything
 * flagging it.
 */
export class PrismaTaskStore implements TaskStore {
  readonly #prisma: PrismaClient;
  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async save(plan: TaskPlan): Promise<void> {
    await this.#prisma.taskPlan.upsert({
      where: { id: plan.id },
      create: {
        id: plan.id,
        userId: plan.userId,
        title: plan.title,
        originClientDeviceId: plan.originClientDeviceId,
        runId: plan.runId,
        conversationId: plan.conversationId,
        correlationId: plan.correlationId,
        status: planStatusToDb(plan.status),
        metadata: plan.metadata,
        createdAt: new Date(plan.createdAt),
        startedAt: dateOrNull(plan.startedAt),
        completedAt: dateOrNull(plan.completedAt),
        steps: { create: plan.steps.map(stepToRow) },
      },
      update: {
        status: planStatusToDb(plan.status),
        metadata: plan.metadata,
        startedAt: dateOrNull(plan.startedAt),
        completedAt: dateOrNull(plan.completedAt),
      },
    });

    for (const step of plan.steps) {
      await this.#prisma.taskStep.updateMany({
        where: { id: step.id, taskId: plan.id },
        data: {
          status: stepStatusToDb(step.status),
          attempt: step.attempt,
          selectedDeviceId: step.selectedDeviceId,
          result: jsonOrNull(step.result),
          error: jsonOrNull(step.error),
          startedAt: dateOrNull(step.startedAt),
          completedAt: dateOrNull(step.completedAt),
        },
      });
    }
  }

  async get(id: string): Promise<TaskPlan | undefined> {
    const plan = await this.#prisma.taskPlan.findUnique({
      where: { id },
      include: { steps: true },
    });
    return plan === null ? undefined : planFromRow(plan);
  }

  async saveExecution(execution: TaskExecution): Promise<void> {
    await this.#prisma.taskExecution.upsert({
      where: { id: execution.id },
      create: {
        id: execution.id,
        taskId: execution.taskId,
        stepId: execution.stepId,
        deviceId: execution.deviceId,
        attempt: execution.attempt,
        status: stepStatusToDb(execution.status),
        startedAt: new Date(execution.startedAt),
        completedAt: dateOrNull(execution.completedAt),
        durationMs: execution.durationMs,
        input: jsonOrNull(execution.input),
        result: jsonOrNull(execution.result),
        error: jsonOrNull(execution.error),
      },
      update: {
        status: stepStatusToDb(execution.status),
        completedAt: dateOrNull(execution.completedAt),
        durationMs: execution.durationMs,
        result: jsonOrNull(execution.result),
        error: jsonOrNull(execution.error),
      },
    });
  }

  async listExecutions(taskId: string): Promise<TaskExecution[]> {
    const executions = await this.#prisma.taskExecution.findMany({
      where: { taskId },
      orderBy: { startedAt: "asc" },
    });
    return executions.map(executionFromRow);
  }

  async listByUser(userId: string, limit = 20): Promise<TaskPlan[]> {
    const plans = await this.#prisma.taskPlan.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { steps: true },
    });
    return plans.map(planFromRow);
  }

  async listActive(): Promise<TaskPlan[]> {
    const plans = await this.#prisma.taskPlan.findMany({
      // Enum values come from the mapping table: hardcoding these three
      // literals would let them drift from domain definitions.
      where: {
        status: {
          in: [
            planStatusToDb("pending"),
            planStatusToDb("running"),
            planStatusToDb("waiting_for_confirmation"),
          ],
        },
      },
      include: { steps: true },
    });
    return plans.map(planFromRow);
  }
}
