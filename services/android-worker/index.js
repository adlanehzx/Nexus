/**
 * Point d'entrée React Native de l'application worker.
 *
 * Il ne fait qu'installer les deux globales que le moteur d'Android n'a pas,
 * puis enregistrer le composant racine. Tout le reste — configuration,
 * capacités, poignée de main, exécution — part de `startAndroidWorker`, appelé
 * par `ui/App.tsx`, et vit dans le code TypeScript partagé et testé.
 */
import { Buffer } from "./shim/node-buffer.js";
import { getRandomValues } from "./shim/node-crypto.js";
import { AppRegistry } from "react-native";

// Hermes n'a ni `Buffer`, ni la Web Crypto API. `@nexus/shared` a besoin de la
// seconde pour produire ses identifiants — c'est la source d'aléa commune à
// Node, au navigateur, à Tauri et à Android. On les installe AVANT tout import
// applicatif : le premier identifiant généré échouerait sinon.
//
// L'aléa vient de `java.security.SecureRandom`, via le module natif. Jamais de
// `Math.random` : ces octets deviennent des identifiants de requête.
if (globalThis.Buffer === undefined) globalThis.Buffer = Buffer;
if (globalThis.crypto === undefined) globalThis.crypto = { getRandomValues };
else if (globalThis.crypto.getRandomValues === undefined) {
  globalThis.crypto.getRandomValues = getRandomValues;
}

import { App } from "./ui/App";
import { name as appName } from "./app.json";

AppRegistry.registerComponent(appName, () => App);
