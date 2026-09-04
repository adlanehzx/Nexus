/**
 * Point d'entrée React Native de l'application worker.
 *
 * Il ne fait qu'enregistrer le composant racine. Tout le reste — configuration,
 * capacités, poignée de main, exécution — part de `startAndroidWorker`, appelé
 * par `ui/App.tsx`, et vit dans le code TypeScript partagé et testé.
 */
import { Buffer } from "./shim/node-buffer.js";
import { AppRegistry } from "react-native";

// `Buffer` est une variable globale de Node, absente du moteur d'Android.
// `@nexus/shared` s'en sert pour formater un UUID v7. On l'installe avant tout
// autre import applicatif, sinon le premier identifiant genere echoue.
if (globalThis.Buffer === undefined) globalThis.Buffer = Buffer;
import { App } from "./ui/App";
import { name as appName } from "./app.json";

AppRegistry.registerComponent(appName, () => App);
