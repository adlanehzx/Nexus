#!/usr/bin/env node
/**
 * Agent ACP local, déterministe, pour les scénarios de bout en bout.
 *
 * C'est un **vrai** agent : il parle le protocole ACP sur son entrée et sa
 * sortie standard, et le runtime de NEXUS ne le distingue en rien d'un agent de
 * fournisseur. Ce qu'il n'a pas, c'est un modèle — il décide par son `--mode`
 * au lieu d'appeler une API payante.
 *
 * Pourquoi un agent plutôt qu'un bouchon posé dans le moteur : tout ce qui est
 * intéressant entre NEXUS et un agent vit dans le protocole — la négociation
 * d'initialisation, les options de session, les demandes de permission, le
 * découpage de la réponse en fragments, le `stopReason`. Un bouchon posé plus
 * haut sauterait exactement la partie qu'on veut éprouver, et les quatre modes
 * ci-dessous sont précisément ce qu'un vrai agent fait vivre au runtime et que
 * personne ne peut provoquer sur commande chez un fournisseur.
 *
 *   --mode succeed          réclame un outil dans l'espace de travail, puis répond
 *   --mode refuse-outside   réclame un chemin hors de l'espace de travail
 *   --mode crash            meurt : c'est ce qui déclenche un repli de profil
 *   --mode review           rend le JSON strict attendu du contrôle qualité
 *
 * La réponse porte le `--marker` reçu et la liste des tâches amont retrouvées
 * dans son instruction. C'est ce qui permet d'affirmer, à la fin de la chaîne,
 * que les résultats ont bien circulé — et pas seulement que des tâches sont
 * passées à `succeeded`.
 *
 * Rien n'est jamais écrit sur la sortie standard en dehors du protocole : elle
 * est le canal. Le diagnostic va sur l'erreur standard, que le runtime capture.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

const MODE = option("mode", "succeed");
const MARKER = option("marker", "sans-marqueur");

/** Chemin volontairement hors de tout espace de travail. */
const FOREIGN_PATH = "/nexus-e2e-chemin-interdit/ailleurs.txt";

/**
 * Les clés des tâches amont dont le résultat a été injecté.
 *
 * Le moteur rend ses dépendances dans un bloc `<DEPENDENCY_RESULTS>`. On lit
 * les `task_key`, et aussi les marqueurs portés par les réponses amont : les
 * premières prouvent que le graphe a été respecté, les seconds que le
 * **contenu** a circulé. Les deux sont nécessaires — un bloc présent mais vide
 * passerait le premier test et pas le second.
 */
function upstream(text) {
  const block = /<DEPENDENCY_RESULTS>([\s\S]*?)<\/DEPENDENCY_RESULTS>/.exec(text);
  if (block === null) return { keys: [], markers: [] };
  const body = block[1];
  const keys = [...body.matchAll(/"task_key"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
  const markers = [...body.matchAll(/MARQUEUR=([a-z0-9_-]+)/gi)].map((match) => match[1]);
  return { keys, markers };
}

function promptText(params) {
  return (params.prompt ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function requestPermission(cx, sessionId, path) {
  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "outil-1",
      title: "Écrire un fichier",
      kind: "edit",
      status: "pending",
      locations: [{ path }],
    },
  });
  const decision = await cx.request(acp.methods.client.session.requestPermission, {
    sessionId,
    toolCall: {
      toolCallId: "outil-1",
      title: "Écrire un fichier",
      kind: "edit",
      status: "pending",
      locations: [{ path }],
    },
    options: [
      { kind: "allow_once", name: "Autoriser", optionId: "autoriser" },
      { kind: "reject_once", name: "Refuser", optionId: "refuser" },
    ],
  });
  if (decision.outcome.outcome === "cancelled") return "annulee";
  return decision.outcome.optionId === "autoriser" ? "autorisee" : "refusee";
}

async function say(cx, sessionId, text) {
  await cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

const sessions = new Set();

if (MODE === "crash") {
  // Avant toute poignée de main : c'est le pire moment pour le runtime, donc
  // le bon moment pour vérifier qu'il le traduit en échec propre et non en
  // blocage. Le message imite une panne de transport, pas un refus
  // d'authentification — celui-ci a sa propre catégorie et son propre repli.
  process.stderr.write(`agent ${MARKER} : panne simulée de transport\n`);
  process.exit(1);
}

acp
  .agent({ name: `nexus-e2e-${MODE}` })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => {
    const sessionId = `e2e-${MARKER}-${sessions.size + 1}`;
    sessions.add(sessionId);
    return { sessionId };
  })
  .onRequest("authenticate", () => ({}))
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId } = ctx.params;
    const instruction = promptText(ctx.params);
    const { keys, markers } = upstream(instruction);

    if (MODE === "review") {
      // Le moteur **analyse** ce verdict et peut relancer un cycle de
      // correction : il doit donc être du JSON strict, sans markdown autour.
      await say(
        ctx.client,
        sessionId,
        JSON.stringify({
          verdict: "pass",
          summary: `revue de ${keys.length} tâche(s) amont, marqueurs ${markers.join("+") || "aucun"}`,
          corrective_instruction: "",
        }),
      );
      return { stopReason: "end_turn" };
    }

    const path = MODE === "refuse-outside" ? FOREIGN_PATH : `${process.cwd()}/note.txt`;
    const permission = await requestPermission(ctx.client, sessionId, path);

    // Deux fragments : la réponse d'un agent arrive en flux, et le runtime doit
    // les recoller. Un seul fragment ne prouverait pas qu'il sait le faire.
    await say(ctx.client, sessionId, `MARQUEUR=${MARKER} `);
    await say(
      ctx.client,
      sessionId,
      `PERMISSION=${permission} AMONT=${keys.join("+") || "aucun"} ` +
        `MARQUEURS_AMONT=${markers.join("+") || "aucun"}`,
    );
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => undefined)
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
