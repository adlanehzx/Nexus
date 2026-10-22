import { useEffect, useRef, useState } from "react";
import { activeTasks, canInteract, pendingConfirmations } from "@nexus/client-core";
import { useNexus } from "../lib/nexus.js";
import { ConfirmationCard, MessageBubble, TaskCard, ToolCard } from "./cards.js";

/**
 * The conversation screen.
 *
 * Three columns, which a desktop screen enables and a phone cannot:
 * conversation list on the left, thread in the center, living context —
 * active tasks, tool calls — on the right.
 *
 * Confirmations stay **above the thread**, out of scrolling. A request
 * that scrolls away with history ends up off-screen, and an action then
 * waits indefinitely without anyone noticing.
 */
export function Chat() {
  const nexus = useNexus();
  const { state } = nexus;
  const [text, setText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  const confirmations = pendingConfirmations(state);
  const activeTaskList = activeTasks(state);
  const interactive = canInteract(state) && nexus.boundDeviceId !== null;

  // The thread follows the response while it streams.
  useEffect(() => {
    const thread = threadRef.current;
    if (thread !== null) thread.scrollTop = thread.scrollHeight;
  }, [nexus.timeline]);

  const sendCurrentMessage = () => {
    const content = text;
    if (content.trim().length === 0 || !interactive) return;

    setText("");
    setIsSending(true);
    void nexus
      .send(content)
      .catch(() => undefined)
      .finally(() => {
        setIsSending(false);
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
          New conversation
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

        <div className="messages" ref={threadRef}>
          {nexus.timeline.length === 0 ? (
            <p className="vide">
              Ask NEXUS anything. Resulting tasks will execute on the capable device — this machine,
              your workstation, or phone.
            </p>
          ) : (
            nexus.timeline.map((message) => <MessageBubble key={message.id} message={message} />)
          )}

          {state.toolCalls.slice(-4).map((call) => (
            <ToolCard key={call.callId} call={call} />
          ))}

          {activeTaskList.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              deviceName={getDeviceName(nexus, task.workerDeviceId)}
              onCancel={(taskId) => {
                void nexus.cancelTask(taskId);
              }}
            />
          ))}
        </div>

        <div className="compositeur">
          <textarea
            className="champ"
            value={text}
            placeholder={
              interactive
                ? "Message NEXUS…  (Enter to send, Shift+Enter for a new line)"
                : "Connecting to NEXUS core…"
            }
            disabled={!interactive}
            onChange={(event) => {
              setText(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendCurrentMessage();
              }
            }}
          />

          <MicroButton />

          <button
            type="button"
            className="bouton primaire"
            disabled={!interactive || isSending || text.trim().length === 0}
            onClick={sendCurrentMessage}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Microphone button.
 *
 * **Hold to talk, never toggled.** Listening begins on `pointerdown` and stops on
 * `pointerup`: no "mic on" state outlives the gesture.
 * This is the same choice as on iOS, for the same reason — a personal assistant
 * that listens permanently is not an assistant.
 */
function MicroButton() {
  const nexus = useNexus();
  const [error, setError] = useState<string | null>(null);

  if (!nexus.voiceAvailable) {
    return (
      <button
        type="button"
        className="bouton"
        disabled
        title="Speech recognition is not available on this device."
      >
        🎤
      </button>
    );
  }

  const releaseMicrophone = () => {
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
      title={error ?? "Hold to talk"}
      onPointerDown={() => {
        setError(null);
        void nexus.voice.startListening().catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "microphone unavailable");
        });
      }}
      onPointerUp={releaseMicrophone}
      onPointerLeave={() => {
        if (nexus.voice.isListening) void nexus.voice.cancelListening().catch(() => undefined);
      }}
    >
      {nexus.voiceState === "listening" ? "● " : ""}🎤
    </button>
  );
}

function getDeviceName(
  nexus: ReturnType<typeof useNexus>,
  deviceId: string | null,
): string | undefined {
  if (deviceId === null) return undefined;
  return nexus.state.devices.find((device) => device.id === deviceId)?.name ?? deviceId;
}
