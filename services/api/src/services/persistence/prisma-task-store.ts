import type { PrismaClient } from "@nexus/database";
import type { TaskStore } from "@nexus/devices";
import type { TaskPlan, TaskExecution } from "@nexus/devices";

export class PrismaTaskStore implements TaskStore {
  readonly #prisma: PrismaClient;
  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async save(plan: TaskPlan): Promise<void> {
    const stepsData = plan.steps.map((step) => ({
      id: step.id,
      key: step.id, // Fallback since 'key' is not in taskStepSchema
      description: step.description,
      requiredCapabilities: step.requiredCapabilities,
      tool: step.tool,
      arguments: step.arguments as any,
      dependsOn: step.dependsOn,
      selectedDeviceId: step.selectedDeviceId,
      preferredDeviceId: step.preferredDeviceId,
      constraints: step.constraints as any,
      riskLevel: step.riskLevel,
      retryPolicy: step.retry as any,
      timeoutMs: step.timeoutMs,
      status: step.status as any,
      attempt: step.attempt,
      result: step.result as any,
      error: step.error as any,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
    }));

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
        status: plan.status as any,
        metadata: plan.metadata as any,
        createdAt: plan.createdAt,
        startedAt: plan.startedAt,
        completedAt: plan.completedAt,
        steps: {
          create: stepsData,
        },
      },
      update: {
        status: plan.status as any,
        metadata: plan.metadata as any,
        startedAt: plan.startedAt,
        completedAt: plan.completedAt,
      },
    });

    for (const step of plan.steps) {
      await this.#prisma.taskStep.updateMany({
        where: { id: step.id, taskId: plan.id },
        data: {
          status: step.status as any,
          attempt: step.attempt,
          selectedDeviceId: step.selectedDeviceId,
          result: step.result as any,
          error: step.error as any,
          startedAt: step.startedAt,
          completedAt: step.completedAt,
        }
      });
    }
  }

  async get(id: string): Promise<TaskPlan | undefined> {
    const plan = await this.#prisma.taskPlan.findUnique({
      where: { id },
      include: { steps: true },
    });
    if (!plan) return undefined;
    return plan as unknown as TaskPlan;
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
        status: execution.status as any,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        durationMs: execution.durationMs,
        input: execution.input as any,
        result: execution.result as any,
        error: execution.error as any,
      },
      update: {
        status: execution.status as any,
        completedAt: execution.completedAt,
        durationMs: execution.durationMs,
        result: execution.result as any,
        error: execution.error as any,
      },
    });
  }

  async listExecutions(taskId: string): Promise<TaskExecution[]> {
    const execs = await this.#prisma.taskExecution.findMany({
      where: { taskId },
      orderBy: { startedAt: "asc" },
    });
    return execs as unknown as TaskExecution[];
  }

  async listByUser(userId: string, limit: number = 20): Promise<TaskPlan[]> {
    const plans = await this.#prisma.taskPlan.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { steps: true },
    });
    return plans as unknown as TaskPlan[];
  }

  async listActive(): Promise<TaskPlan[]> {
    const plans = await this.#prisma.taskPlan.findMany({
      where: {
        status: { in: ["PENDING", "RUNNING", "WAITING_FOR_CONFIRMATION"] }
      },
      include: { steps: true },
    });
    return plans as unknown as TaskPlan[];
  }
}

