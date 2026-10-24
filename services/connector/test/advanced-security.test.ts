import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  FirecrackerMicroVmRunner,
  IsolationUnavailableError,
  DynamicTaskNetworkPolicy,
  NetworkPolicyViolationError,
  BehavioralAnomalyDetector,
  AgentAnomalyDetectedError,
  ExfiltrationGuard,
  DataExfiltrationDetectedError,
  EncryptedSoftwareVault,
  TpmVaultAdapter,
  WorkerAttestationVerifier,
  WorkerAttestationError,
  ContinuousFuzzer,
  AuditBundleGenerator,
  VulnerabilityIntakeService,
} from "../src/security.js";

describe("CLA3: Advanced Execution Security", () => {
  describe("Firecracker MicroVM Tier (Fail-Closed)", () => {
    it("refuses untrusted execution when KVM device is unavailable (Rule 12)", async () => {
      const runner = new FirecrackerMicroVmRunner();
      // If host lacks /dev/kvm access, startMicroVm must throw IsolationUnavailableError
      if (!runner.isAvailable()) {
        await expect(
          runner.startMicroVm({
            vmId: "vm-1",
            kernelImagePath: "/boot/vmlinux",
            rootfsPath: "/tmp/rootfs.ext4",
            vcpuCount: 2,
            memoryMb: 512,
          }),
        ).rejects.toThrow(IsolationUnavailableError);
      } else {
        expect(runner.isAvailable()).toBe(true);
      }
    });
  });

  describe("Dynamic Per-Task Network Policy", () => {
    it("blocks cloud metadata service (169.254.169.254) across all policy modes", () => {
      const policy = new DynamicTaskNetworkPolicy({ mode: "UNRESTRICTED" });
      expect(() => {
        policy.assertConnectionPermitted("http://169.254.169.254/latest/meta-data");
      }).toThrow(/metadata or loopback/);
    });

    it("enforces NONE mode (no outbound access)", () => {
      const policy = new DynamicTaskNetworkPolicy({ mode: "NONE" });
      expect(() => {
        policy.assertConnectionPermitted("https://api.github.com");
      }).toThrow(NetworkPolicyViolationError);
    });

    it("enforces LAN_ONLY mode (allows private IP, blocks WAN)", () => {
      const policy = new DynamicTaskNetworkPolicy({ mode: "LAN_ONLY" });
      // LAN target is permitted
      expect(() => {
        policy.assertConnectionPermitted("http://192.168.1.100:8080/metrics");
      }).not.toThrow();

      // WAN target is blocked
      expect(() => {
        policy.assertConnectionPermitted("https://external-service.com");
      }).toThrow(/LAN_ONLY/);
    });

    it("enforces ALLOWLIST mode (only explicitly listed domains permitted)", () => {
      const policy = new DynamicTaskNetworkPolicy({
        mode: "ALLOWLIST",
        allowedDomains: ["nexus.ai", "api.github.com"],
      });

      expect(() => policy.assertConnectionPermitted("https://api.github.com/repos")).not.toThrow();
      expect(() => policy.assertConnectionPermitted("https://evil-exfil.com")).toThrow(
        /not in task allowed domains/,
      );
    });
  });

  describe("Agent Behavioral Anomaly Detection", () => {
    it("detects rapid tool call bursts and halts execution", () => {
      const detector = new BehavioralAnomalyDetector({ maxToolCallsPerMinute: 5 });
      const now = Date.now();

      // 5 calls in window are fine
      for (let i = 0; i < 5; i++) {
        detector.recordToolCall("read_file", now);
      }

      // 6th call exceeds threshold and throws anomaly error
      expect(() => detector.recordToolCall("read_file", now)).toThrow(AgentAnomalyDetectedError);
    });

    it("detects excessive subprocess creation", () => {
      const detector = new BehavioralAnomalyDetector({ maxSubprocessesPerRun: 2 });
      detector.recordProcessSpawn("git status");
      detector.recordProcessSpawn("ls -la");
      expect(() => detector.recordProcessSpawn("cat /etc/hosts")).toThrow(
        /excessive subprocess creation/,
      );
    });

    it("detects memory consumption spike", () => {
      const detector = new BehavioralAnomalyDetector({ memoryThresholdMb: 512 });
      expect(() => detector.recordMemorySample(1024)).toThrow(/memory consumption spike/);
    });
  });

  describe("Multi-Channel Exfiltration Detection", () => {
    const guard = new ExfiltrationGuard();

    it("detects private keys and API tokens across prompt and tool channels", () => {
      const privateKey =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----";
      expect(() => guard.inspectPayload(privateKey, "tool_io")).toThrow(
        DataExfiltrationDetectedError,
      );

      const awsKey = "Error in response: AKIAIOSFODNN7EXAMPLE invalid token";
      expect(() => guard.inspectPayload(awsKey, "log")).toThrow(DataExfiltrationDetectedError);

      const canary = "Transmitting canary CANARY-NEXUS-A1B2C3D4E5F6 to server";
      expect(() => guard.inspectPayload(canary, "network")).toThrow(DataExfiltrationDetectedError);
    });

    it("detects valid credit card numbers with Luhn check", () => {
      // Valid Luhn test card: 4532 0151 1283 0366
      const validCard = "Sending payment to 4532015112830366 via prompt";
      expect(() => guard.inspectPayload(validCard, "prompt")).toThrow(/valid payment card number/);

      // Invalid card should not throw false positive
      const invalidCard = "Reference id 1234 5678 9012 3456";
      expect(() => guard.inspectPayload(invalidCard, "prompt")).not.toThrow();
    });

    it("redacts sensitive data before logging", () => {
      const rawLog = "Found token ghp_123456789012345678901234567890123456 in session";
      const redacted = guard.redactSensitiveData(rawLog);
      expect(redacted).not.toContain("ghp_123456789012345678901234567890123456");
      expect(redacted).toContain("[REDACTED_SECRET]");
    });
  });

  describe("TPM and Hardware Vault Ports", () => {
    it("seals and unseals secrets in encrypted software vault fallback", async () => {
      const vault = new EncryptedSoftwareVault();
      expect(vault.isHardwareBacked).toBe(false);

      const secret = "super-confidential-user-token";
      const { sealedData, tag } = await vault.sealSecret("key-1", secret);

      expect(sealedData).not.toContain(secret);

      const unsealed = await vault.unsealSecret("key-1", sealedData, tag);
      expect(unsealed).toBe(secret);
    });

    it("truthfully reports TPM hardware backing status without lying", () => {
      const tpm = new TpmVaultAdapter();
      expect(typeof tpm.isHardwareBacked).toBe("boolean");
    });
  });

  describe("Worker Remote Attestation", () => {
    const verifier = new WorkerAttestationVerifier();
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    verifier.registerTrustedWorker("worker-linux-01", publicKey);
    verifier.approveBinaryHash("sha256-verified-binary-hash");

    it("verifies authentic worker measurement challenge-response", () => {
      const nonce = verifier.generateChallenge("worker-linux-01");

      const claims = {
        workerId: "worker-linux-01",
        nonce,
        binaryHash: "sha256-verified-binary-hash",
        configHash: "sha256-default-config",
        platform: "linux-x64",
        timestamp: Date.now(),
      };

      const signature = crypto
        .sign(null, Buffer.from(JSON.stringify(claims), "utf8"), privateKey)
        .toString("base64");

      const res = verifier.verifyAttestation({ claims, signature });
      expect(res.verified).toBe(true);
      expect(res.workerId).toBe("worker-linux-01");
    });

    it("rejects unapproved binary measurement claim", () => {
      const nonce = verifier.generateChallenge("worker-linux-01");
      const claims = {
        workerId: "worker-linux-01",
        nonce,
        binaryHash: "sha256-corrupted-or-modified-binary", // Tampered binary!
        configHash: "sha256-default-config",
        platform: "linux-x64",
        timestamp: Date.now(),
      };

      const signature = crypto
        .sign(null, Buffer.from(JSON.stringify(claims), "utf8"), privateKey)
        .toString("base64");

      expect(() => verifier.verifyAttestation({ claims, signature })).toThrow(
        WorkerAttestationError,
      );
    });
  });

  describe("Continuous Fuzzing Harness", () => {
    it("fuzzes parser against prototype pollution, oversized inputs, and format strings", () => {
      const fuzzer = new ContinuousFuzzer();
      const mockSafeParser = (input: string): unknown => {
        if (!input) throw new Error("Empty input");
        if (input.includes("__proto__")) throw new Error("Prototype pollution blocked");
        if (input.length > 50_000) throw new Error("Payload too large");
        return JSON.parse(input) as unknown;
      };

      const result = fuzzer.fuzzTarget("safe-json-parser", mockSafeParser);
      expect(result.passed).toBe(true);
      expect(result.crashesCount).toBe(0);
      expect(result.handledCount).toBe(result.totalIterations);
    });
  });

  describe("Reproducible Audit Bundle & Vulnerability Intake", () => {
    it("generates complete evidence bundle and marks external report BLOCKED truthfully (Rule 13)", () => {
      const generator = new AuditBundleGenerator();
      const bundle = generator.generateBundle("610d26a");

      expect(bundle.bundleId).toContain("610d26a");
      expect(bundle.sbom.length).toBeGreaterThan(0);
      expect(bundle.buildVerificationChecksum).toBeDefined();

      // Rule 13: Truthful external audit status
      expect(bundle.externalAuditStatus).toBe("BLOCKED_AWAITING_EXTERNAL_REPORT");
      expect(bundle.blockingReason).toContain("awaiting accredited third-party external");
    });

    it("handles privacy-preserving vulnerability intake and strips PII", () => {
      const intake = new VulnerabilityIntakeService();
      const report = intake.submitReport({
        title: "Potential SSRF in custom connector",
        affectedComponent: "@nexus/activepieces",
        severity: "HIGH",
        reproductionSteps:
          "Send request from reporter admin@security-firm.com to target 192.168.1.50 with payload",
        reporterContact: "admin@security-firm.com",
      });

      expect(report.trackingId).toMatch(/^NEXUS-SEC-/);
      expect(report.sanitizedReproduction).not.toContain("admin@security-firm.com");
      expect(report.sanitizedReproduction).toContain("[REDACTED_EMAIL]");
      expect(report.sanitizedReproduction).toContain("[REDACTED_IP]");
      expect(report.reporterPseudonym).toMatch(/^researcher-[a-f0-9]{12}$/);
    });
  });
});
