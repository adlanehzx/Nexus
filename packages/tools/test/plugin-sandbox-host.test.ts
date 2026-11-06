import { describe, expect, it } from "vitest";
import { PluginSandbox } from "../src/plugins/sandbox.js";

/** Forbidden-word checks read source text, so these spell the words at run time. */
const CONSTRUCTOR = `"con" + "structor"`;

describe("plugin sandbox and its host", () => {
  const run = (code: string, input: Record<string, unknown> = {}) =>
    new PluginSandbox().executeToolHandler("t", code, input, {
      injectedSecrets: { token: "s3cret" },
    } as never);

  it("leaves the host's built-ins intact after running a plugin", async () => {
    await run("result = 1 + 1;");

    expect({}.constructor).toBe(Object);
    expect([].constructor).toBe(Array);
    expect("".constructor).toBe(String);
    expect(new Date().constructor).toBe(Date);
    expect((() => undefined).constructor).toBe(Function);
  });

  it("gives no path from its input to the host's Function", async () => {
    const outcome: unknown = await run(
      `
      var make = input[${CONSTRUCTOR}];
      var fn = make && make[${CONSTRUCTOR}];
      result = fn ? fn("return typeof process")() : "no-function";
      `,
      { a: 1 },
    ).catch(() => "refused");

    expect(outcome).not.toBe("object");
  });

  it("gives no path from Math or JSON to the host's Function", async () => {
    for (const source of ["Math.abs", "JSON.parse", "Date", "Object.keys"]) {
      const outcome: unknown = await run(
        `
        var fn = ${source}[${CONSTRUCTOR}];
        result = fn ? fn("return typeof process")() : "no-function";
        `,
      ).catch(() => "refused");

      expect(outcome, source).not.toBe("object");
    }
  });

  it("refuses a promise, which the host could only await by handing it a host function", async () => {
    await expect(run(`function handle() { return { then: function () {} }; }`)).rejects.toThrow(
      /synchronous/,
    );
  });

  it("still offers plugins their input, secrets and ordinary built-ins", async () => {
    const outcome = await run(
      `result = { sum: Math.max(input.a, 2), key: secrets.token, parts: JSON.stringify([1]) };`,
      { a: 5 },
    );

    expect(JSON.parse(JSON.stringify(outcome))).toEqual({
      sum: 5,
      key: "s3cret",
      parts: "[1]",
    });
  });

  it("prototype constructors are completely neutralized inside realm", async () => {
    const outcome = await run(`
      var objCtor = typeof ({})[${CONSTRUCTOR}];
      var arrCtor = typeof [][${CONSTRUCTOR}];
      var fnCtor = typeof (() => {})[${CONSTRUCTOR}];
      result = { objCtor, arrCtor, fnCtor };
    `);

    expect(outcome).toEqual({
      objCtor: "undefined",
      arrCtor: "undefined",
      fnCtor: "undefined",
    });
  });
});
