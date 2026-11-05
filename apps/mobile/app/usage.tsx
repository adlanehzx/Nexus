import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  Badge,
  Card,
  FailureView,
  ProgressBar,
  ResourceScreen,
  SectionHeader,
  Stat,
  StatRow,
  StateView,
} from "../components/ui.js";
import type { LlmEnginesSection, ProviderAccount, UsageReport } from "../lib/api-types.js";
import { describeFailure, type Failure } from "../lib/errors.js";
import { formatRelative } from "../lib/format.js";
import { useNexus } from "../lib/nexus.js";
import { useResource } from "../lib/use-resource.js";
import { formatTokens, formatUsd, summarizeUsage } from "../lib/usage.js";
import { type Theme, useThemedStyles } from "../theme/index.js";

const PERIODS = [7, 30, 90] as const;

interface UsageData {
  usage: UsageReport | undefined;
  usageFailure: Failure | undefined;
  accounts: ProviderAccount[];
  engines: LlmEnginesSection | undefined;
}

/**
 * What NEXUS consumed, from its own records.
 *
 * Three sources with different standing, kept visibly apart: tokens are
 * observed on our side; quotas are what a provider's tool reported; costs are an
 * estimate from prices an administrator declared. Billed cost is shown only when
 * the core reports one. Nothing is filled in when a source has nothing to say.
 */
export default function UsageScreen() {
  const styles = useThemedStyles(makeStyles);
  const nexus = useNexus();
  const [days, setDays] = useState<number>(30);

  const resource = useResource<UsageData>(`usage:${String(days)}`, async () => {
    const [usage, accounts, engines] = await Promise.allSettled([
      nexus.mobile.usage(days),
      nexus.mobile.providerAccounts(),
      nexus.mobile.llmEngines(),
    ]);
    return {
      usage: usage.status === "fulfilled" ? usage.value : undefined,
      usageFailure: usage.status === "rejected" ? describeFailure(usage.reason) : undefined,
      accounts: accounts.status === "fulfilled" ? accounts.value : [],
      engines: engines.status === "fulfilled" ? engines.value : undefined,
    };
  });

  return (
    <ResourceScreen resource={resource}>
      {({ usage, usageFailure, accounts, engines }) => {
        const summary =
          usage === undefined ? undefined : summarizeUsage(usage.runs, engines?.engines ?? []);
        return (
          <>
            <View style={styles.periods} accessibilityRole="radiogroup">
              {PERIODS.map((period) => (
                <Pressable
                  key={period}
                  style={[styles.period, days === period && styles.periodSelected]}
                  onPress={() => {
                    setDays(period);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: days === period }}
                  accessibilityLabel={`Last ${String(period)} days`}
                >
                  <Text style={[styles.periodText, days === period && styles.periodTextSelected]}>
                    {period} days
                  </Text>
                </Pressable>
              ))}
            </View>

            {usageFailure !== undefined && <FailureView failure={usageFailure} />}

            {summary !== undefined && usage !== undefined && (
              <>
                <StatRow>
                  <Stat label="Runs" value={String(summary.runs)} />
                  <Stat label="Input tokens" value={formatTokens(summary.inputTokens)} />
                  <Stat label="Output tokens" value={formatTokens(summary.outputTokens)} />
                </StatRow>

                <Card>
                  <SectionHeader title="Cost" />
                  {usage.billedCostUsd !== null ? (
                    <Text style={styles.value}>{formatUsd(usage.billedCostUsd)} billed</Text>
                  ) : summary.estimatedCostUsd !== null ? (
                    <Text style={styles.value}>
                      ≈ {formatUsd(summary.estimatedCostUsd)} estimated
                    </Text>
                  ) : (
                    <Text style={styles.muted}>
                      No estimate: no engine declares a price for the models used.
                    </Text>
                  )}
                  {usage.billedCostUsd === null && summary.estimatedCostUsd !== null && (
                    <Text style={styles.muted}>
                      From prices configured on your engines, not from provider invoices.
                      {summary.unpricedModels > 0
                        ? ` ${String(summary.unpricedModels)} model${summary.unpricedModels > 1 ? "s" : ""} without a price excluded.`
                        : ""}
                    </Text>
                  )}
                </Card>

                {summary.byModel.length > 0 && <SectionHeader title="By model" />}
                {summary.byModel.map((model) => (
                  <Card key={model.model}>
                    <Text style={styles.title} numberOfLines={1}>
                      {model.model}
                    </Text>
                    <Text style={styles.muted}>
                      {model.runs} runs
                      {model.failedRuns > 0 ? ` (${String(model.failedRuns)} failed)` : ""} ·{" "}
                      {formatTokens(model.inputTokens)} in · {formatTokens(model.outputTokens)} out
                      {model.estimatedCostUsd === null
                        ? ""
                        : ` · ≈ ${formatUsd(model.estimatedCostUsd)}`}
                    </Text>
                  </Card>
                ))}
                {summary.runs === 0 && (
                  <StateView
                    icon="pulse-outline"
                    title="No recorded usage"
                    message={`No agent run in the last ${String(days)} days.`}
                  />
                )}
              </>
            )}

            {accounts.length > 0 && <SectionHeader title="Provider quotas" />}
            {accounts.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </>
        );
      }}
    </ResourceScreen>
  );
}

function AccountCard({ account }: { account: ProviderAccount }) {
  const styles = useThemedStyles(makeStyles);
  const { remaining5hPercent, remainingWeekPercent, resets5hAt, resetsWeekAt, exhausted } =
    account.quotas;
  const unknown = remaining5hPercent === null && remainingWeekPercent === null;
  return (
    <Card>
      <View style={styles.spread}>
        <Text style={styles.title} numberOfLines={1}>
          {account.name}
        </Text>
        <Badge
          {...(exhausted
            ? { label: "exhausted", tone: "bad" as const }
            : account.cooldown.active
              ? { label: "cooldown", tone: "warn" as const }
              : { status: account.authStatus })}
        />
      </View>
      <Text style={styles.muted}>{account.provider}</Text>
      {unknown && <Text style={styles.muted}>This provider does not report quota data.</Text>}
      {remaining5hPercent !== null && (
        <Quota label="5-hour window" percent={remaining5hPercent} resetsAt={resets5hAt} />
      )}
      {remainingWeekPercent !== null && (
        <Quota label="Weekly" percent={remainingWeekPercent} resetsAt={resetsWeekAt} />
      )}
    </Card>
  );
}

function Quota({
  label,
  percent,
  resetsAt,
}: {
  label: string;
  percent: number;
  resetsAt: string | null;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.muted}>
        {label}: {percent}% left
        {resetsAt === null ? "" : ` · resets ${formatRelative(resetsAt)}`}
      </Text>
      <ProgressBar percent={percent} tone={percent < 15 ? "bad" : percent < 40 ? "warn" : "ok"} />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    periods: { flexDirection: "row", gap: theme.space(3) },
    period: {
      flex: 1,
      minHeight: 36,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.pill,
      borderWidth: 1,
      borderColor: theme.color.border,
    },
    periodSelected: { backgroundColor: theme.color.accentMuted, borderColor: theme.color.accent },
    periodText: { color: theme.color.textMuted, fontSize: 13, fontWeight: "600" },
    periodTextSelected: { color: theme.color.accent },
    spread: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    title: { color: theme.color.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
    value: { color: theme.color.text, fontSize: 22, fontWeight: "700" },
    muted: { color: theme.color.textMuted, fontSize: 13, lineHeight: 18 },
  });
