import { describe, expect, it } from "vitest";
import {
  TYPE,
  answersFor,
  collectServices,
  decodeMessage,
  encodeMessage,
  type ServiceAdvertisement,
} from "../src/services/domotique/mdns.js";

const NEXUS: ServiceAdvertisement = {
  type: "_nexus._tcp.local",
  instance: "NEXUS studio",
  port: 3000,
  host: "studio.local",
  addresses: ["10.0.0.5"],
  txt: { v: "1", enroll: "/api/v1/satellites/enroll", ws: "/ws/satellite" },
};

describe("mDNS for zero-configuration discovery", () => {
  it("answers a DNS-SD browse for _nexus._tcp with PTR, SRV, TXT and A", () => {
    const query = decodeMessage(
      encodeMessage({
        id: 0,
        response: false,
        questions: [{ name: "_nexus._tcp.local", type: TYPE.PTR }],
        answers: [],
      }),
    );
    const answers = answersFor(query.questions, NEXUS);
    expect(answers.map((a) => a.type).sort()).toEqual(
      [TYPE.A, TYPE.PTR, TYPE.TXT, TYPE.SRV].sort(),
    );

    // What an ESP32 would parse from our reply.
    const reply = decodeMessage(encodeMessage({ id: 0, response: true, questions: [], answers }));
    expect(reply.response).toBe(true);
    expect(collectServices("_nexus._tcp.local", reply.answers)).toEqual([
      {
        instance: "nexus studio._nexus._tcp.local",
        host: "studio.local",
        port: 3000,
        addresses: ["10.0.0.5"],
        txt: NEXUS.txt,
      },
    ]);
  });

  it("stays silent for other services and answers direct host lookups", () => {
    expect(answersFor([{ name: "_googlecast._tcp.local", type: TYPE.PTR }], NEXUS)).toEqual([]);
    expect(answersFor([{ name: "studio.local", type: TYPE.A }], NEXUS)).toEqual([
      { name: "studio.local", type: TYPE.A, ttl: 120, data: "10.0.0.5" },
    ]);
  });

  it("decodes compressed names as sent by real responders (Home Assistant)", () => {
    // PTR record whose target uses a compression pointer back to the question name.
    const header = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
    const qname = Buffer.from("\x0f_home-assistant\x04_tcp\x05local\x00", "latin1");
    const question = Buffer.concat([qname, Buffer.from([0, 12, 0, 1])]);
    const target = Buffer.concat([Buffer.from("\x04Home", "latin1"), Buffer.from([0xc0, 12])]);
    const rr = Buffer.concat([
      Buffer.from([0xc0, 12, 0, 12, 0, 1, 0, 0, 0x11, 0x94, 0, target.length]),
      target,
    ]);
    const message = decodeMessage(Buffer.concat([header, question, rr]));
    expect(message.answers).toEqual([
      {
        name: "_home-assistant._tcp.local",
        type: TYPE.PTR,
        ttl: 4500,
        data: "Home._home-assistant._tcp.local",
      },
    ]);
  });
});
