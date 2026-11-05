import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Empty, Section, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

const ROLES = ["ORG_ADMIN", "TEAM_MANAGER", "MEMBER", "AUDITOR", "BILLING_ADMIN"] as const;
const MANAGING_ROLES = new Set(["OWNER", "ORG_ADMIN"]);

export function Organizations({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const organizations = useSection(() => api.organizations());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    organizations.data?.organizations.find((org) => org.id === selectedId) ??
    organizations.data?.organizations[0];
  const members = useSection(
    () =>
      selected === undefined
        ? Promise.resolve({ members: [] })
        : api.organizationMembers(selected.id),
    [selected?.id],
  );
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("MEMBER");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("Action failed.", "Échec de l'action."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content">
      <h2>{tr("Organizations", "Organisations")}</h2>
      <p className="muted">
        {tr(
          "Your personal organization is created for you; nothing else is required to use NEXUS alone.",
          "Votre organisation personnelle est créée pour vous ; rien d’autre n’est nécessaire pour utiliser NEXUS seul.",
        )}
      </p>
      {error === null ? null : (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {notice === null ? null : (
        <div className="banner success" role="status">
          {notice}
        </div>
      )}
      <Section state={organizations}>
        {(data) => (
          <Table
            head={[
              tr("Name", "Nom"),
              tr("Identifier", "Identifiant"),
              tr("Mode", "Mode"),
              tr("Your role", "Votre rôle"),
              "",
            ]}
          >
            {data.organizations.map((org) => (
              <tr key={org.id} data-organization={org.slug}>
                <td>{org.name}</td>
                <td className="mono">{org.slug}</td>
                <td>{org.mode}</td>
                <td>{org.role}</td>
                <td>
                  <button
                    className="button compact"
                    type="button"
                    aria-pressed={selected?.id === org.id}
                    onClick={() => setSelectedId(org.id)}
                  >
                    {tr("Members", "Membres")}
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <form
        className="usage-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            async () => {
              await api.createOrganization({ name, slug });
              setName("");
              setSlug("");
              organizations.reload();
            },
            tr("Organization created.", "Organisation créée."),
          );
        }}
      >
        <label>
          {tr("Organization name", "Nom de l’organisation")}{" "}
          <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {tr("Identifier", "Identifiant")}{" "}
          <input
            required
            minLength={2}
            maxLength={63}
            pattern="[a-z0-9-]+"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
        <button className="button primary" type="submit" disabled={busy}>
          {tr("Create organization", "Créer l’organisation")}
        </button>
      </form>
      {selected === undefined ? null : (
        <section className="settings-panel">
          <h3>
            {tr("Members of", "Membres de")} {selected.name}
          </h3>
          <Section state={members}>
            {(data) =>
              data.members.length === 0 ? (
                <Empty>{tr("No member.", "Aucun membre.")}</Empty>
              ) : (
                <Table head={[tr("Name", "Nom"), tr("Email", "E-mail"), tr("Role", "Rôle")]}>
                  {data.members.map((member) => (
                    <tr key={member.userId} data-member={member.email}>
                      <td>{member.displayName}</td>
                      <td>{member.email}</td>
                      <td>{member.role}</td>
                    </tr>
                  ))}
                </Table>
              )
            }
          </Section>
          {MANAGING_ROLES.has(selected.role) ? (
            <form
              className="usage-filters"
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  async () => {
                    await api.addOrganizationMember(selected.id, { email, role });
                    setEmail("");
                    members.reload();
                  },
                  tr("Member saved.", "Membre enregistré."),
                );
              }}
            >
              <label>
                {tr("Member email", "E-mail du membre")}{" "}
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                {tr("Role", "Rôle")}{" "}
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <button className="button primary" type="submit" disabled={busy}>
                {tr("Add member", "Ajouter le membre")}
              </button>
            </form>
          ) : (
            <p className="muted">
              {tr(
                "Your role does not allow managing members.",
                "Votre rôle ne permet pas de gérer les membres.",
              )}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
