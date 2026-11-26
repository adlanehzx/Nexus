import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type State = { routes: { name: string; params?: Record<string, unknown> }[] };
type Options = { screens: Record<string, string> };
const { getStateFromPath } =
  require("expo-router/build/react-navigation/core/getStateFromPath") as {
    getStateFromPath(path: string, options: Options): State;
  };
const { getPathFromState } =
  require("expo-router/build/react-navigation/core/getPathFromState") as {
    getPathFromState(state: State, options: Options): string;
  };
const options = { screens: { Conversation: "chat/:id" } };

describe("patched Expo Router query codec", () => {
  it("preserves conversation links with Unicode, spaces and repeated values", () => {
    const state = getStateFromPath("/chat/mission-1?q=caf%C3%A9%20test&tag=a&tag=b", options);
    expect(state.routes[0]?.params).toMatchObject({
      id: "mission-1",
      q: "café test",
      tag: ["a", "b"],
    });
    const path = getPathFromState(state, options);
    // React Navigation serializes array params to comma-separated strings.
    expect(getStateFromPath(path, options).routes[0]?.params).toEqual({
      id: "mission-1",
      q: "café test",
      tag: "a,b",
    });
  });

  it("handles malformed percent escapes without breaking navigation", () => {
    const state = getStateFromPath("/chat/mission-2?q=%E0%A4%A&empty=&flag", options);
    expect(state.routes[0]?.name).toBe("Conversation");
    expect(state.routes[0]?.params).toMatchObject({ id: "mission-2", empty: "", flag: null });
    expect(() => getPathFromState(state, options)).not.toThrow();
  });
});
