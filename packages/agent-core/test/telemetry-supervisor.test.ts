import { describe, it, expect } from "vitest";
import { TelemetrySupervisor } from "../src/index.js";
import { TelemetryReportSchema } from "@nexus/protocol";

describe("Unified Telemetry Supervisor", () => {
  it("samples process resource telemetry and generates valid TelemetryReport", () => {
    const supervisor = new TelemetrySupervisor({
      hostId: "nexus-dev-host",
      agentInstanceId: "agent-session-42",
    });

    const sample1 = supervisor.sample("agent-runner");
    expect(sample1.pid).toBe(process.pid);
    expect(sample1.memoryBytes).toBeGreaterThan(0);
    expect(typeof sample1.cpuPercent).toBe("number");
    expect(sample1.timestamp).toBeDefined();

    const sample2 = supervisor.sample("agent-runner");
    expect(sample2.memoryBytes).toBeGreaterThan(0);

    const report = supervisor.generateReport();
    expect(report.hostId).toBe("nexus-dev-host");
    expect(report.agentInstanceId).toBe("agent-session-42");
    expect(report.metrics.length).toBe(2);
    expect(report.systemMemoryTotalBytes).toBeGreaterThan(0);
    expect(report.systemMemoryFreeBytes).toBeGreaterThan(0);

    // Validate with Zod schema from @nexus/protocol
    const validation = TelemetryReportSchema.safeParse(report);
    if (!validation.success) {
      console.error("VALIDATION ERROR:", JSON.stringify(validation.error.format(), null, 2));
    }
    expect(validation.success).toBe(true);
  });
});
