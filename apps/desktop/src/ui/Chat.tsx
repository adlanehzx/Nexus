import { useEffect, useRef, useState } from "react";
import { activeTasks, canInteract, pendingConfirmations } from "@nexus/client-core";
import { useNexus } from "../lib/nexus.js";
import { ConfirmationCard, MessageBubble, TaskCard, ToolCard } from "./cards.js";

/**
 * L'écran de conversation.
 *
 * Trois colonnes, ce qu'un écran de bureau permet et qu'un téléphone
 * n'autorise pas : la liste des conversations à gauche, le fil au centre, le
 * contexte vivant — tâches en cours, appels d'outils — à droite.
 *
 * Les confirmations restent **au-dessus du fil**, hors du défilement. Une
 * demande qui remonte avec l'historique finit par sortir de l'écran, et une
 * action attend alors indéfiniment sans que personne ne le sache.
 */
export function Chat() {
  const nexus = useNexus();
  const { state } = nexus;
  const [texte, setTexte] = useState("");
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const filRef = useRef<HTMLDivElement>(null);

  const confirmations = pendingConfirmations(state);
  const enCours = activeTasks(state);
  const interactif = canInteract(state) && nexus.boundDeviceId !== null;

  // Le fil suit la réponse pendant qu'elle s'écrit.
  useEffect(() => {
    const fil = filRef.current;
    if (fil !== null) fil.scrollTop = fil.scrollHeight;
  }, [nexus.timeline]);

  const envoyer = () => {
    const contenu = texte;
    if (contenu.trim().length === 0 || !interactif) return;

    setTexte("");
    setEnvoiEnCours(true);
    void nexus
      .send(contenu)
      .catch(() => undefined)
      .finally(() => {
        setEnvoiEnCours(false);
      });
  };

  return (
    <div className="conversation">
      <aside className="liste-conversations">
        <button
          type="button"
          className="bouton primaire"
          style={{ width: "100%", marginBottom: 10 }}
          onClick={() => {
            void nexus.openConversation(null);
          }}
        >
          Nouvelle conversation
        </button>

        {nexus.conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            aria-current={conversation.id === nexus.activeConversationId}
            onClick={() => {
              void nexus.openConversation(conversation.id);
            }}
          >
            {conversation.title}
          </button>
        ))}
      </aside>

      <div className="fil">
        {confirmations.length === 0 ? null : (
          <div style={{ padding: "12px 18px 0" }}>
            {confirmations.map((confirmation) => (
              <ConfirmationCard
                key={confirmation.id}
                confirmation={confirmation}
                onDecide={(id, decision) => {
                  void nexus.answerConfirmation(id, decision);
                }}
              />
            ))}
          </div>
        )}

        <div className="messages" ref={filRef}>
          {nexus.timeline.length === 0 ? (
            <p className="vide">
              Demandez quelque chose à NEXUS. Les tâches qui en découlent s'exécuteront sur la
              machine capable de les faire — ce poste, le poste fixe, ou le téléphone.
            </p>
          ) : (
            nexus.timeline.map((message) => <MessageBubble key={message.id} message={message} />)
          )}

          {state.toolCalls.slice(-4).map((call) => (
            <ToolCard key={call.callId} call={call} />
          ))}

          {enCours.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              deviceName={nomAppareil(nexus, task.workerDeviceId)}
              onCancel={(taskId) => {
                void nexus.cancelTask(taskId);
              }}
            />
          ))}
        </div>

        <div className="compositeur">
          <textarea
            className="champ"
            value={texte}
            placeholder={
              interactif
                ? "Écrivez à NEXUS…  (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)"
                : "Connexion au cœur NEXUS…"
            }
            disabled={!interactif}
            onChange={(event) => {
              setTexte(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                envoyer();
              }
            }}
          />

          <MicroButton />

          <button
            type="button"
            className="bouton primaire"
            disabled={!interactif || envoiEnCours || texte.trim().length === 0}
            onClick={envoyer}
          >
            Envoyer
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Le micro.
 *
 * **Maintenu, jamais commuté.** L'écoute démarre au `pointerdown` et s'arrête au
 * `pointerup` : il n'existe aucun état « micro allumé » qui survivrait au geste.
 * C'est le même choix que sur l'iPhone, pour la même raison — un assistant
 * personnel qui écoute en permanence n'est pas un assistant.
 */
function MicroButton() {
  const nexus = useNexus();
  const [erreur, setErreur] = useState<string | null>(null);

  if (!nexus.voiceAvailable) {
    return (
      <button
        type="button"
        className="bouton"
        disabled
        title="Ce poste ne fournit pas de reconnaissance vocale."
      >
        🎤
      </button>
    );
  }

  const relacher = () => {
    void nexus.voice
      .stopListening()
      .then(async (transcription) => {
        if (transcription !== undefined && transcription.trim().length > 0) {
          await nexus.send(transcription);
        }
      })
      .catch(() => undefined);
  };

  return (
    <button
      type="button"
      className={`bouton ${nexus.voiceState === "listening" ? "primaire" : ""}`}
      title={erreur ?? "Maintenir pour parler"}
      onPointerDown={() => {
        setErreur(null);
        void nexus.voice.startListening().catch((cause: unknown) => {
          setErreur(cause instanceof Error ? cause.message : "micro indisponible");
        });
      }}
      onPointerUp={relacher}
      onPointerLeave={() => {
        if (nexus.voice.isListening) void nexus.voice.cancelListening().catch(() => undefined);
      }}
    >
      {nexus.voiceState === "listening" ? "● " : ""}🎤
    </button>
  );
}

function nomAppareil(
  nexus: ReturnType<typeof useNexus>,
  deviceId: string | null,
): string | undefined {
  if (deviceId === null) return undefined;
  return nexus.state.devices.find((device) => device.id === deviceId)?.name ?? deviceId;
}
