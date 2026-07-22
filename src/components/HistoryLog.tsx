import { Fragment, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n } from "@/i18n";
import type { CheckItem } from "@/components/DetectionChecklist";
import type { AttachmentAnalysisReport } from "@/lib/attachments";
import type {
  AuthenticityEvidenceLevel,
  AuthenticityReason,
  AuthenticityVerdict,
  VerifierScope,
} from "@/lib/authenticity";

export interface HistoryEntry {
  storageId?: string;
  id: string;
  source?: "web" | "api" | "retest";
  timestamp: string;
  model: string;
  endpoint: string;
  apiKey: string;
  score: number | null;
  capabilityScore?: number;
  authenticityScore?: number;
  resultKind?: "text" | "image";
  profileId?: string;
  status: AuthenticityVerdict;
  evidenceLevel?: AuthenticityEvidenceLevel;
  verdictReason?: AuthenticityReason;
  verifierScope?: VerifierScope;
  checks?: CheckItem[];
  latency?: number;
  tps?: number;
  inputTokens?: number;
  outputTokens?: number;
  canRetest?: boolean;
  attachments?: Array<{ id: string; original_name?: string; name?: string; url?: string; size_bytes?: number }>;
  attachmentAnalysis?: AttachmentAnalysisReport | null;
}

interface HistoryLogProps {
  entries: HistoryEntry[];
  onSelect?: (entry: HistoryEntry) => void;
  onClear?: () => void;
  onRetest?: (entry: HistoryEntry) => void;
  retestingId?: string | null;
}

function getEndpointDisplay(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "-";

  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    // Keep a non-default port visible so local test services on different
    // ports are not collapsed into the same history label.
    return parsed.host || parsed.hostname || trimmed;
  } catch {
    return trimmed.replace(/^https?:\/\//i, "").split("/")[0] || trimmed;
  }
}

function getCompactTimestamp(timestamp: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) {
    return timestamp.slice(5, 16);
  }
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function getDisplayTimestamp(timestamp: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) return timestamp;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toLocaleString();
}

function hasExpandableContent(entry: HistoryEntry): boolean {
  return Boolean(
    entry.checks?.length ||
    entry.latency !== undefined ||
    entry.tps !== undefined ||
    entry.inputTokens !== undefined ||
    entry.outputTokens !== undefined ||
    entry.attachments?.length ||
    entry.attachmentAnalysis ||
    entry.canRetest,
  );
}

export function HistoryLog({ entries, onSelect, onClear, onRetest, retestingId }: HistoryLogProps) {
  const { t } = useI18n();
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const verdictMeta = (verdict: AuthenticityVerdict, reason?: AuthenticityReason) => {
    if (reason === "upstream-unavailable") return { Icon: CircleHelp, label: t("upstreamUnavailable"), className: "text-warning" };
    if (reason === "stage-fingerprint-conflict") return { Icon: AlertTriangle, label: t("authVerdictStageFingerprint"), className: "text-warning" };
    if (reason === "custom-profile-echo") return { Icon: CircleHelp, label: t("authVerdictCustomProfileEcho"), className: "text-warning" };
    if (verdict === "verified") return { Icon: CheckCircle2, label: t("authVerdictVerified"), className: "text-success" };
    if (verdict === "consistent") return { Icon: ShieldCheck, label: t("authVerdictConsistent"), className: "text-primary" };
    if (verdict === "suspicious") return { Icon: AlertTriangle, label: t("authVerdictSuspicious"), className: "text-error" };
    return { Icon: CircleHelp, label: t("authVerdictUnverifiable"), className: "text-warning" };
  };
  const evidenceLabel = (level?: AuthenticityEvidenceLevel) => {
    if (level === "provider-transport") return t("evidenceProviderTransport");
    if (level === "cryptographic") return t("evidenceCryptographic");
    if (level === "behavioral") return t("evidenceBehavioral");
    if (level === "conflict") return t("evidenceConflict");
    return t("evidenceInsufficient");
  };
  const sourceLabel = (source?: HistoryEntry["source"]) => source === "api"
    ? t("historySourceApi")
    : source === "retest"
      ? t("historySourceRetest")
      : t("historySourceWeb");

  if (entries.length === 0) {
    return (
      <div className="py-2">
        <div className="mb-4">
          <h3 className="text-lg font-semibold tracking-tight text-foreground">{t("historyTitle")}</h3>
        </div>
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-3">
            <span className="text-2xl">🔬</span>
          </div>
          <p className="text-sm font-medium">{t("historyEmptyTitle")}</p>
          <p className="text-xs mt-1">{t("historyEmptyDescription")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="py-2">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">{t("historyTitle")}</h3>
        {entries.length > 0 && onClear && (
          <button
            onClick={onClear}
            className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("historyClear")}
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="w-[88px] sm:w-auto text-left py-2 text-xs font-mono text-muted-foreground uppercase tracking-wider font-medium">{t("historyTimestamp")}</th>
              <th className="w-[72px] sm:w-auto text-left py-2 text-xs font-mono text-muted-foreground uppercase tracking-wider font-medium">{t("historyModel")}</th>
              <th className="w-[92px] sm:w-auto text-left py-2 text-xs font-mono text-muted-foreground uppercase tracking-wider font-medium">{t("historyEndpoint")}</th>
              <th className="w-[48px] sm:w-auto text-right py-2 text-xs font-mono text-muted-foreground uppercase tracking-wider font-medium">{t("historyScore")}</th>
              <th className="w-[40px] sm:w-auto text-center py-2 text-xs font-mono text-muted-foreground uppercase tracking-wider font-medium">{t("historyStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
                const rowId = entry.storageId ?? entry.id;
                const isExpanded = expandedEntryId === rowId;
                const canExpand = hasExpandableContent(entry);
                const statusMeta = verdictMeta(entry.status, entry.verdictReason);
                const StatusIcon = statusMeta.Icon;

                return (
                  <Fragment key={rowId}>
                    <tr
                      onClick={() => {
                        if (canExpand) {
                          setExpandedEntryId(isExpanded ? null : rowId);
                        }
                        onSelect?.(entry);
                      }}
                      onKeyDown={(event) => {
                        if (canExpand && (event.key === "Enter" || event.key === " ")) {
                          event.preventDefault();
                          setExpandedEntryId(isExpanded ? null : rowId);
                          onSelect?.(entry);
                        }
                      }}
                      tabIndex={canExpand ? 0 : undefined}
                      aria-expanded={canExpand ? isExpanded : undefined}
                      role={canExpand ? "button" : undefined}
                      className={`border-b border-border cursor-pointer transition-colors ${isExpanded ? "bg-muted/35" : "hover:bg-muted/50"}`}
                    >
                      <td className="py-3 text-foreground">
                        <span className="hidden sm:inline">{getDisplayTimestamp(entry.timestamp)}</span>
                        <span className="inline sm:hidden text-xs">{getCompactTimestamp(entry.timestamp)}</span>
                      </td>
                      <td className="py-3">
                        <span
                          className="block max-w-[72px] truncate whitespace-nowrap px-1.5 py-0.5 text-[11px] font-mono font-medium text-foreground sm:max-w-none sm:px-2 sm:text-xs"
                          title={entry.model}
                        >
                          {entry.model}
                        </span>
                        {entry.source && <span className="ml-1.5 text-[10px] text-muted-foreground">{sourceLabel(entry.source)}</span>}
                      </td>
                      <td className="py-3 text-muted-foreground font-mono text-xs">
                        <span
                          className="block max-w-[92px] truncate whitespace-nowrap sm:max-w-none"
                          title={getEndpointDisplay(entry.endpoint)}
                        >
                          {getEndpointDisplay(entry.endpoint)}
                        </span>
                      </td>
                      <td
                        className="py-3 text-right text-xs sm:text-sm font-semibold tabular-nums"
                        style={{ color: "rgb(0, 17, 44)" }}
                      >
                        {entry.score === null ? "—" : `${entry.score}%`}
                      </td>
                      <td className="py-3 text-center" title={statusMeta.label}>
                        <span className={`inline-flex items-center justify-center gap-1 text-xs font-medium ${statusMeta.className}`}>
                          <StatusIcon className="h-4 w-4 shrink-0" />
                          <span className="hidden lg:inline">{statusMeta.label}</span>
                        </span>
                      </td>
                    </tr>

                    {isExpanded && canExpand && (
                      <tr className="border-b border-border last:border-b-0">
                        <td colSpan={5} className="px-0 pt-0 pb-3">
                          <motion.div
                            initial={{ opacity: 0, y: -6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
                            className="w-full bg-[rgb(244,245,246)] px-4 py-3 sm:px-5"
                          >
                            <div className="flex items-end justify-between gap-4 pb-2.5">
                              <div className="min-w-0">
                                <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                                  {t("historyScore")}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-3">
                                {entry.canRetest && onRetest && entry.storageId && (
                                  <button
                                    type="button"
                                    disabled={retestingId === entry.storageId}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      onRetest(entry);
                                    }}
                                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-60"
                                  >
                                    <RefreshCw className={`h-3.5 w-3.5 ${retestingId === entry.storageId ? "animate-spin" : ""}`} />
                                    {retestingId === entry.storageId ? t("historyRetesting") : t("historyRetest")}
                                  </button>
                                )}
                                <div
                                  className="text-right text-2xl font-medium tabular-nums"
                                  style={{ color: "rgb(0, 17, 44)" }}
                                >
                                  {entry.score === null ? "—" : `${entry.score}%`}
                                </div>
                              </div>
                            </div>

                            {entry.attachments && entry.attachments.length > 0 && (
                              <div className="mb-3 flex flex-wrap gap-x-1 border-y border-black/5 py-2 text-xs text-muted-foreground">
                                {entry.attachments.map((attachment, index) => {
                                  const label = attachment.original_name || attachment.name || attachment.id;
                                  const url = attachment.url?.startsWith("/upload/") ? attachment.url : null;
                                  return (
                                    <Fragment key={`${attachment.id}-${index}`}>
                                      {index > 0 && <span aria-hidden="true">·</span>}
                                      {url ? (
                                        <a
                                          href={url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="break-all underline decoration-border underline-offset-2 hover:text-foreground"
                                          onClick={(event) => event.stopPropagation()}
                                        >
                                          {label}
                                        </a>
                                      ) : <span className="break-all">{label}</span>}
                                    </Fragment>
                                  );
                                })}
                              </div>
                            )}

                            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                              <div className="border-l-2 border-primary/60 pl-2">
                                <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{t("resultAuthenticityVerdict")}</div>
                                <div className={`mt-0.5 text-sm font-semibold ${statusMeta.className}`}>{statusMeta.label}</div>
                              </div>
                              <div className="border-l-2 border-border pl-2">
                                <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{t("resultEvidenceLevel")}</div>
                                <div className="mt-0.5 text-sm font-semibold text-foreground">{evidenceLabel(entry.evidenceLevel)}</div>
                              </div>
                            </div>

                            {entry.checks && entry.checks.length > 0 && (
                              <div className="space-y-0">
                                {entry.checks.map((item, index) => {
                                  return (
                                    <div
                                      key={`${entry.id}-${item.name}-${index}`}
                                      className="flex items-center justify-between gap-3 border-b border-black/5 py-2 last:border-b-0"
                                    >
                                      <div className="min-w-0">
                                        <span className="text-xs text-foreground">{item.name}</span>
                                      </div>
                                      <span className="shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-xs text-foreground">
                                        {item.detail}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {(entry.latency !== undefined ||
                              entry.tps !== undefined ||
                              entry.inputTokens !== undefined ||
                              entry.outputTokens !== undefined) && (
                              <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
                                {entry.latency !== undefined && (
                                  <div>
                                    <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                                      {t("metricLatency")}
                                    </div>
                                    <div className="mt-0.5 text-sm font-normal tabular-nums text-foreground">
                                      {entry.latency}ms
                                    </div>
                                  </div>
                                )}
                                {entry.tps !== undefined && (
                                  <div>
                                    <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                                      {t("metricTokensPerSecond")}
                                    </div>
                                    <div className="mt-0.5 text-sm font-normal tabular-nums text-foreground">
                                      {entry.tps}
                                    </div>
                                  </div>
                                )}
                                {entry.inputTokens !== undefined && (
                                  <div>
                                    <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                                      {t("metricInputTokens")}
                                    </div>
                                    <div className="mt-0.5 text-sm font-normal tabular-nums text-foreground">
                                      {entry.inputTokens}
                                    </div>
                                  </div>
                                )}
                                {entry.outputTokens !== undefined && (
                                  <div>
                                    <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                                      {t("metricOutputTokens")}
                                    </div>
                                    <div className="mt-0.5 text-sm font-normal tabular-nums text-foreground">
                                      {entry.outputTokens}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </motion.div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
