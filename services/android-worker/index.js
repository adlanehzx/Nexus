/**
 * React Native entry point for worker application.
 *
 * It installs the two globals that the Android engine lacks,
 * then registers the root component. Everything else — configuration,
 * capabilities, handshake, execution — starts from `startAndroidWorker`,
 * called by `ui/App.tsx`, and lives in shared and tested TypeScript code.
 */
import { Buffer } from "./shim/node-buffer.js";
import { getRandomValues } from "./shim/node-crypto.js";
import { AppRegistry } from "react-native";

// Hermes has neither `Buffer` nor the Web Crypto API. `@nexus/shared` needs the
// latter to produce its IDs — it is the common randomness source across Node,
// browser, Tauri, and Android. We install them BEFORE any application import:
// the first generated ID would otherwise fail.
//
// Randomness comes from `java.security.SecureRandom` via the native module.
// Never `Math.random`: these bytes become request IDs.
if (globalThis.Buffer === undefined) globalThis.Buffer = Buffer;
if (globalThis.crypto === undefined) globalThis.crypto = { getRandomValues };
else if (globalThis.crypto.getRandomValues === undefined) {
  globalThis.crypto.getRandomValues = getRandomValues;
}

import { App } from "./ui/App";
import { name as appName } from "./app.json";

AppRegistry.registerComponent(appName, () => App);
