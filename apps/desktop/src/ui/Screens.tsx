import { useEffect, useState } from "react";
import {
  activeTasks,
  finishedTasks,
  unreadNotifications,
  type ApiMemoryHit,
} from "@nexus/client-core";
import { useNexus } from "../lib/nexus.js";
import { TaskCard } from "./cards.js";
import type { LocalWorkerState } from "../lib/worker-status.js";

/**
 * Les écrans secondaires.
 *
 * Tâches, appareils, notifications, mémoire, exécutant local, réglages. Aucun
 * ne prend de décision : ils lisent l'état publié par le cœur et l'affichent.
 *
 * Un point est constant d'un écran à l'autre : **rien ici ne s'adresse à une
 * machine.** Ni la liste d'appareils, ni l'écran de l'exécutant local ne
 * proposent « exécuter ici ». Une action part toujours vers le cœur, qui
 * autorise et choisit.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tâches
// ─────────────────────────────────────────────────────────────────────────────

export function Tasks() {
  const nexus = useNexus();
  const enCours = activeTasks(nexus.state);
  const terminees = finishedTasks(nexus.state);

  const nom = (deviceId: string | null) =>
    deviceId === null
      ? undefined
      : (nexus.state.devices.find((device) => device.id === deviceId)?.name ?? deviceId);

  return (
    <div className="contenu">
      <h3>En cours ({enCours.length})</h3>
      {enCours.length === 0 ? (
        <p className="faible">Aucune tâche en cours.</p>
      ) : (
        enCours.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            deviceName={nom(task.workerDeviceId)}
            onCancel={(taskId) => {
              void nexus.cancelTask(taskId);
            }}
          />
        ))
      )}

      <h3 style={{ marginTop: 24 }}>Terminées ({terminees.length})</h3>
      {terminees.length === 0 ? (
        <p className="faible">Rien encore.</p>
      ) : (
        terminees.map((task) => (
          <TaskCard key={task.id} task={task} deviceName={nom(task.workerDeviceId)} />
        ))
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Appareils
// ─────────────────────────────────────────────────────────────────────────────

export function Devices() {
  const nexus = useNexus();
  const [occupe, setOccupe] = useState(false);

  useEffect(() => {
    void nexus.refreshDevices().catch(() => undefined);
    // Chargement au montage uniquement : `refreshDevices` est recréée à chaque
    // rendu et l'inclure relancerait une requête en boucle.
  }, []);

  const revoquer = (deviceId: string, nom: string) => {
    if (!globalThis.confirm(`Révoquer « ${nom} » ? Il faudra le réappairer.`)) return;

    setOccupe(true);
    void nexus.api
      .revokeDevice(deviceId)
      .then(() => nexus.refreshDevices())
      .catch(() => undefined)
      .finally(() => {
        setOccupe(false);
      });
  };

  return (
    <div className="contenu">
      <div className="rangee" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="bouton"
          disabled={occupe}
          onClick={() => {
            void nexus.refreshDevices().catch(() => undefined);
          }}
        >
          Actualiser
        </button>
        <span className="faible">
          Un appareil se rattache à cette fenêtre depuis les Réglages ; il ne s'y pilote pas.
        </span>
      </div>

      {nexus.state.devices.map((device) => (
        <article key={device.id} className="carte">
          <header>
            <strong>
              {device.name}
              {device.id === nexus.boundDeviceId ? " — cette fenêtre" : ""}
              {device.id === nexus.worker.deviceId ? " — exécutant de ce poste" : ""}
            </strong>
            <span className={`etiquette ${device.status === "ONLINE" ? "ok" : "attention"}`}>
              {device.status}
            </span>
          </header>

          <div className="faible">
            rôle {device.role}
            {device.lastSeenAt === null ? "" : ` · vu ${device.lastSeenAt}`}
          </div>
          <div className="faible">
            {device.capabilities.length === 0
              ? "aucune capacité déclarée"
              : device.capabilities.join(", ")}
          </div>

          <div className="rangee" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="bouton danger"
              disabled={occupe}
              onClick={() => {
                revoquer(device.id, device.name);
              }}
            >
              Révoquer
            </button>
          </div>
        </article>
      ))}

      {nexus.state.devices.length === 0 ? <p className="vide">Aucun appareil.</p> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

export function Notifications() {
  const nexus = useNexus();

  return (
    <div className="contenu">
      <p className="faible">
        Les notifications sont produites par le cœur et poussées à tous vos appareils. Marquée lue
        ici, une notification l'est aussi sur l'iPhone.
      </p>

      {nexus.state.notifications.map((notification) => (
        <article key={notification.id} className="carte">
          <header>
            <strong>{notification.title}</strong>
            <span
              className={`etiquette ${
                notification.severity === "error"
                  ? "ko"
                  : notification.severity === "warning"
                    ? "attention"
                    : ""
              }`}
            >
              {notification.severity}
            </span>
          </header>
          <div>{notification.body}</div>
          <div className="rangee" style={{ marginTop: 8 }}>
            <span className="faible">{notification.createdAt}</span>
            {notification.readAt === null ? (
              <button
                type="button"
                className="bouton"
                onClick={() => {
                  void nexus.markNotificationRead(notification.id);
                }}
              >
                Marquer comme lue
              </button>
            ) : (
              <span className="faible">lue</span>
            )}
          </div>
        </article>
      ))}

      {nexus.state.notifications.length === 0 ? <p className="vide">Rien à signaler.</p> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mémoire
// ─────────────────────────────────────────────────────────────────────────────

export function Memory() {
  const nexus = useNexus();
  const [requete, setRequete] = useState("");
  const [resultats, setResultats] = useState<ApiMemoryHit[]>([]);
  const [nouveau, setNouveau] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const chercher = () => {
    if (requete.trim().length === 0) return;
    void nexus.api
      .searchMemory(requete.trim())
      .then(setResultats)
      .catch(() => {
        setMessage("Recherche impossible.");
      });
  };

  const enregistrer = () => {
    if (nouveau.trim().length === 0) return;
    void nexus.api
      .storeMemory({ content: nouveau.trim() })
      .then(() => {
        setNouveau("");
        setMessage("Souvenir enregistré.");
      })
      .catch((cause: unknown) => {
        // Le cœur explique pourquoi il refuse — secret, ou information
        // personnelle sans accord. Remplacer son message par « échec »
        // priverait l'utilisateur de la seule information utile.
        setMessage(cause instanceof Error ? cause.message : "Enregistrement impossible.");
      });
  };

  return (
    <div className="contenu">
      <div className="rangee" style={{ marginBottom: 14 }}>
        <input
          className="champ"
          value={requete}
          placeholder="Rechercher dans la mémoire…"
          onChange={(event) => {
            setRequete(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") chercher();
          }}
        />
        <button type="button" className="bouton primaire" onClick={chercher}>
          Chercher
        </button>
      </div>

      {resultats.map((hit) => (
        <article key={hit.id} className="carte">
          <header>
            <span className="etiquette">{hit.kind}</span>
            <span className="faible">score {hit.score.toFixed(2)}</span>
          </header>
          <div>{hit.content}</div>
        </article>
      ))}

      <h3 style={{ marginTop: 24 }}>Ajouter un souvenir</h3>
      <textarea
        className="champ"
        rows={3}
        value={nouveau}
        placeholder="Ce que NEXUS doit retenir…"
        onChange={(event) => {
          setNouveau(event.target.value);
        }}
      />
      <div className="rangee" style={{ marginTop: 8 }}>
        <button type="button" className="bouton" onClick={enregistrer}>
          Enregistrer
        </button>
        {message === null ? null : <span className="faible">{message}</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Exécutant local
// ─────────────────────────────────────────────────────────────────────────────

const TON_ETAT: Record<LocalWorkerState, string> = {
  absent: "",
  unpaired: "attention",
  pending: "attention",
  offline: "attention",
  degraded: "attention",
  online: "ok",
  revoked: "ko",
};

/**
 * Supervision de l'exécutant installé sur ce poste.
 *
 * Écran de **lecture**. On y voit ce que le cœur sait de la machine : son état,
 * ses capacités, sa charge. On n'y trouve ni bouton « exécuter », ni console, ni
 * accès aux journaux du démon — l'interface et l'exécutant sont deux processus
 * séparés, et la fenêtre n'a pas de prise sur le second.
 *
 * Pour arrêter l'exécutant, on révoque l'appareil : la décision passe alors par
 * le cœur, elle est tracée, et l'iPhone la voit aussi.
 */
export function Worker() {
  const nexus = useNexus();
  const worker = nexus.worker;

  return (
    <div className="contenu">
      <article className="carte">
        <header>
          <strong>{worker.name ?? "Exécutant local"}</strong>
          <span className={`etiquette ${TON_ETAT[worker.state]}`}>{worker.state}</span>
        </header>
        <div>{worker.summary}</div>

        {worker.deviceId === null ? null : (
          <>
            <div className="faible" style={{ marginTop: 8 }}>
              appareil {worker.deviceId}
            </div>
            <div className="faible">
              {worker.activeTasks}/{worker.maxConcurrentTasks} tâche(s) —{" "}
              {worker.acceptingTasks ? "accepte de nouvelles étapes" : "n'en accepte pas"}
            </div>
            <div className="faible">
              {worker.capabilities.length === 0
                ? "aucune capacité déclarée"
                : worker.capabilities.join(", ")}
            </div>
          </>
        )}
      </article>

      <p className="faible">
        Cet écran affiche ce que <strong>le cœur</strong> sait de l'exécutant, pas ce que le démon
        raconte de lui-même. C'est la vue du cœur qui décide où partent les tâches ; afficher autre
        chose ferait mentir l'interface.
      </p>

      <h3 style={{ marginTop: 24 }}>Autres exécutants ({nexus.fleet.length})</h3>
      {nexus.fleet.map((device) => (
        <article key={device.id} className="carte">
          <header>
            <strong>{device.name}</strong>
            <span className={`etiquette ${device.status === "ONLINE" ? "ok" : "attention"}`}>
              {device.status}
            </span>
          </header>
          <div className="faible">
            {device.capabilities.length === 0
              ? "aucune capacité déclarée"
              : device.capabilities.join(", ")}
          </div>
        </article>
      ))}

      <p className="faible">
        Le poste fixe et le téléphone apparaissent ici. Ils ne se pilotent pas depuis cette liste :
        une tâche déclare les capacités dont elle a besoin, et le cœur choisit la machine.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Réglages
// ─────────────────────────────────────────────────────────────────────────────

export function Settings() {
  const nexus = useNexus();
  const [lecture, setLecture] = useState(nexus.voice.speakRepliesEnabled);

  return (
    <div className="contenu">
      <article className="carte">
        <header>
          <strong>Cette fenêtre</strong>
        </header>
        <div className="faible">
          coquille : {nexus.shell.kind === "tauri" ? "Tauri (fenêtre native)" : "navigateur"}
        </div>
        {nexus.shell.kind === "web" ? (
          <p className="faible">
            Hors coquille native, les jetons restent <strong>en mémoire</strong> et disparaissent au
            rechargement. C'est volontaire : écrire un jeton de rafraîchissement dans le stockage du
            navigateur le rendrait lisible par n'importe quel script de la page.
          </p>
        ) : null}
      </article>

      <article className="carte">
        <header>
          <strong>Appareil rattaché</strong>
        </header>
        <p className="faible">
          Cette fenêtre parle au cœur au nom d'un appareil. Sur ce poste, c'est celui que le démon
          exécutant a appairé — le même identifiant sert aux deux canaux, avec deux secrets
          différents.
        </p>

        <select
          className="champ"
          value={nexus.boundDeviceId ?? ""}
          onChange={(event) => {
            if (event.target.value.length > 0) {
              void nexus.bindDevice(event.target.value).catch(() => undefined);
            }
          }}
        >
          <option value="">— aucun —</option>
          {nexus.state.devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name} ({device.role})
            </option>
          ))}
        </select>
      </article>

      <article className="carte">
        <header>
          <strong>Voix</strong>
        </header>
        <div className="faible">
          reconnaissance vocale :{" "}
          {nexus.voiceAvailable ? "disponible" : "indisponible sur ce poste"}
        </div>
        <label className="rangee" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={lecture}
            onChange={(event) => {
              setLecture(event.target.checked);
              nexus.voice.setSpeakReplies(event.target.checked);
            }}
          />
          Lire les réponses à voix haute
        </label>
        <p className="faible">
          Le micro ne s'active que tant que le bouton est maintenu. Il n'existe aucune écoute
          permanente, et le port de reconnaissance vocale n'en propose pas.
        </p>
      </article>

      <article className="carte">
        <header>
          <strong>Session</strong>
        </header>
        <button
          type="button"
          className="bouton danger"
          onClick={() => {
            void nexus.signOut().catch(() => undefined);
          }}
        >
          Se déconnecter
        </button>
      </article>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function unreadCount(nexus: ReturnType<typeof useNexus>): number {
  return unreadNotifications(nexus.state).length;
}
