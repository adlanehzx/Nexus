import { describe, expect, it } from "vitest";
import {
  PeerSyncEngine,
  RevokedDeviceDecryptionError,
  UnauthorizedPeerPayloadError,
  type DeviceIdentity,
  type PeerSyncPayload,
} from "../src/offline/peer-sync.js";

describe("End-to-End Encrypted Peer Synchronization", () => {
  it("encrypts and decrypts state between approved peer devices", () => {
    const userId = "user_adlane";
    const phoneEngine = new PeerSyncEngine({
      userId,
      localDeviceId: "dev_iphone_15",
    });

    const laptopIdentity: DeviceIdentity = {
      deviceId: "dev_macbook_pro",
      userId,
      name: "MacBook Pro",
      publicKey: "aabbccdd11223344",
      trusted: true,
      revoked: false,
    };

    // Trust laptop on phone
    phoneEngine.addPeerDevice(laptopIdentity);

    const payload: PeerSyncPayload = {
      mutationId: "mut_draft_1",
      type: "TASK_DRAFT",
      data: { prompt: "Analyze server logs", targetAgent: "claude" },
      originDeviceId: "dev_iphone_15",
      userId,
      timestamp: Date.now(),
    };

    // Encrypt on phone
    const packet = phoneEngine.encryptPayload(payload);
    expect(packet.epoch).toBe(2);
    expect(packet.ciphertextHex).toBeDefined();

    // Decrypt on laptop
    const decrypted = phoneEngine.decryptPacket(packet, "dev_macbook_pro");
    expect(decrypted.mutationId).toBe("mut_draft_1");
    expect(decrypted.data.prompt).toBe("Analyze server logs");
  });

  it("strictly prohibits cross-tenant peer synchronization", () => {
    const engine = new PeerSyncEngine({
      userId: "tenant_alpha",
      localDeviceId: "dev_alpha_1",
    });

    const foreignDevice: DeviceIdentity = {
      deviceId: "dev_beta_1",
      userId: "tenant_beta", // Different tenant!
      name: "Foreign Device",
      publicKey: "11223344",
      trusted: true,
      revoked: false,
    };

    expect(() => engine.addPeerDevice(foreignDevice)).toThrowError(UnauthorizedPeerPayloadError);
  });

  it("revoked devices cannot decrypt newly synchronized state (cryptographic forward secrecy)", () => {
    const userId = "user_adlane";
    const engine = new PeerSyncEngine({
      userId,
      localDeviceId: "dev_workstation",
    });

    const tabletIdentity: DeviceIdentity = {
      deviceId: "dev_tablet_compromised",
      userId,
      name: "Old Tablet",
      publicKey: "99887766",
      trusted: true,
      revoked: false,
    };

    engine.addPeerDevice(tabletIdentity);

    // Initial packet while trusted -> tablet can decrypt
    const initialPayload: PeerSyncPayload = {
      mutationId: "mut_before_revocation",
      type: "NOTE_DRAFT",
      data: { title: "Draft Note" },
      originDeviceId: "dev_workstation",
      userId,
      timestamp: Date.now(),
    };
    const packetBefore = engine.encryptPayload(initialPayload);
    expect(engine.decryptPacket(packetBefore, "dev_tablet_compromised").mutationId).toBe(
      "mut_before_revocation",
    );

    // Revoke tablet
    engine.revokeDevice("dev_tablet_compromised");
    expect(engine.currentEpoch).toBe(3);

    // New packet encrypted under epoch 3
    const newPayload: PeerSyncPayload = {
      mutationId: "mut_after_revocation",
      type: "NOTE_DRAFT",
      data: { secret: "Sensitive update" },
      originDeviceId: "dev_workstation",
      userId,
      timestamp: Date.now(),
    };
    const packetAfter = engine.encryptPayload(newPayload);

    // Tablet attempt to decrypt MUST fail closed
    expect(() => engine.decryptPacket(packetAfter, "dev_tablet_compromised")).toThrowError(
      RevokedDeviceDecryptionError,
    );
  });
});
