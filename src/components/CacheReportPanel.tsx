import { ChevronDown } from "lucide-react";
import { useI18n } from "@/i18n";
import type { CacheReport, CacheRound } from "@/lib/cache";

function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000) {
    return `${Number((value / 1000).toFixed(2))}k`;
  }
  return Number(value.toFixed(2)).toString();
}

function deltaText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const rounded = Math.round(value);
  if (rounded === 0) return "";
  return ` (${rounded > 0 ? "+" : ""}${rounded}%)`;
}

function multiplierTone(value: number | null | undefined): string {
  if (value === null || value === undefined) return "text-muted-foreground";
  if (value >= 0.7 && value <= 1.1) return "text-success";
  if (value > 1.1 && value <= 1.2) return "text-success";
  if (value < 0.7 || value <= 1.5) return "text-warning";
  return "text-error";
}

function scoreTone(score: number | null | undefined): string {
  if (score === null || score === undefined) return "text-muted-foreground";
  if (score >= 80) return "text-success";
  if (score >= 60) return "text-warning";
  return "text-error";
}

function statusTone(status: CacheReport["status"]): string {
  if (status === "confirmed") return "text-success";
  if (status === "partial" || status === "incomplete" || status === "unconfirmed" || status === "unobserved") return "text-warning";
  if (status === "failed") return "text-error";
  return "text-muted-foreground";
}

function roundAssessment(round: CacheRound, t: ReturnType<typeof useI18n>["t"]): string {
  const value = round.multiplier;
  if (value === null || value === undefined) return "-";
  if (value >= 0.7 && value <= 1.1) return t("cacheAssessmentNormal");
  if (value < 0.7) return t("cacheAssessmentLow");
  if (value <= 1.2) return t("cacheAssessmentSlightHigh");
  if (value <= 1.5) return t("cacheAssessmentHigh");
  return t("cacheAssessmentAbnormal");
}

export function CacheReportPanel({ report }: { report: CacheReport }) {
  const { t } = useI18n();
  const wireReport = report as CacheReport & {
    requested_runs?: number;
    completed_runs?: number;
    aggregation_method?: "single" | "median";
  };
  const compared = report.baselineComparison === "compared";
  const normalizedObservationModel = String(report.observationModel ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[(?:1m|fast)\]$/i, "");
  const fableObservation = ["claude-fable-5", "claude-5-fable", "fable5", "fable-5"].includes(normalizedObservationModel);
  const logicalRounds = report.logicalRounds ?? 5;
  const completedRounds = report.completedRounds ?? report.rounds.length;
  const requiredWarmRounds = report.requiredWarmRounds ?? Math.max(0, logicalRounds - 1);
  const observedWarmRounds = report.observedWarmRounds ?? report.rounds
    .slice(1, 1 + requiredWarmRounds)
    .filter((round) => round.evidence || (round.evidenceFields?.length ?? 0) > 0)
    .length;
  const requestAttempts = report.requestAttempts ?? completedRounds;
  const requestedRuns = Math.max(1, report.requestedRuns ?? wireReport.requested_runs ?? (report.runs?.length || 1));
  const completedRuns = Math.max(0, report.completedRuns ?? wireReport.completed_runs ?? (report.runs?.filter((run) => (
    (run.completedRounds ?? run.rounds.length) >= (run.logicalRounds ?? 5) && run.status !== "failed" && run.status !== "partial" && run.status !== "incomplete"
  )).length ?? (requestedRuns === 1 && completedRounds >= logicalRounds ? 1 : 0)));
  const aggregation = report.aggregation ?? wireReport.aggregation_method ?? (requestedRuns > 1 ? "median" : "single");
  const groupReports = report.runs ?? [];
  const hasMultipleRuns = requestedRuns > 1 || groupReports.length > 1;
  const multiRunUnconfirmed = hasMultipleRuns && report.applicable &&
    completedRuns === requestedRuns && report.status === "unconfirmed";
  const score = compared ? report.compatibilityScore ?? null : null;
  const arithmeticHitRate = compared ? report.comparisonHitRate ?? report.hitRate : report.hitRate;
  const weightedWarmHitRate = report.warmHitRate;
  const hitRateTone = typeof arithmeticHitRate !== "number"
    ? "text-muted-foreground"
    : arithmeticHitRate >= 80
      ? "text-success"
      : arithmeticHitRate >= 60
        ? "text-warning"
        : "text-error";
  const scoreLabel = report.reason === "upstream_unavailable"
    ? t("cacheUpstreamUnavailable")
    : multiRunUnconfirmed
      ? t("cacheMultiRunUnconfirmed")
    : !report.applicable
    ? report.reason === "protocol_not_supported"
      ? t("cacheProtocolNotSupported")
      : report.reason === "model_not_supported"
        ? t("cacheModelNotSupported")
        : t("cacheNotApplicable")
    : score === null
      ? report.status === "confirmed"
      ? t("cacheConfirmed")
      : report.status === "partial" || report.status === "incomplete"
        ? t("cachePartial")
        : report.status === "failed"
          ? t("cacheFailed")
          : report.status === "unobserved"
            ? t("cacheUnobserved")
            : t("cacheUnconfirmed")
      : score >= 80 ? t("cacheScoreNormal") : score >= 60 ? t("cacheScoreDeviated") : t("cacheScoreAbnormal");
  const labelTone = !report.applicable || multiRunUnconfirmed
    ? "text-warning"
    : score === null ? statusTone(report.status) : scoreTone(score);
  const metrics = compared
    ? [
        { label: t("cacheCompatibilityScore"), value: score === null ? "-" : `${score}/100`, tone: scoreTone(score) },
        { label: t("cacheBaselineWeighted"), value: compactNumber(report.baselineCostIndex), tone: "text-foreground" },
        { label: t("cacheMeasuredWeighted"), value: compactNumber(report.measuredCostIndex), tone: "text-foreground" },
        { label: t("cacheOverallMultiplier"), value: report.baselineMultiplier === null || report.baselineMultiplier === undefined ? "-" : `${Number(report.baselineMultiplier.toFixed(2))}x`, tone: multiplierTone(report.baselineMultiplier) },
        { label: t("cacheHitRate"), value: arithmeticHitRate === null || arithmeticHitRate === undefined ? "-" : `${Math.round(arithmeticHitRate)}%`, tone: hitRateTone },
        { label: t("cacheWarmHitRate"), value: weightedWarmHitRate === null || weightedWarmHitRate === undefined ? "-" : `${Math.round(weightedWarmHitRate)}%`, tone: "text-foreground" },
      ]
    : [
        { label: t("cacheRounds"), value: report.applicable ? `${completedRounds}/${logicalRounds}` : "-", tone: "text-foreground" },
        { label: t("cacheHitRate"), value: arithmeticHitRate === null || arithmeticHitRate === undefined ? "-" : `${Math.round(arithmeticHitRate)}%`, tone: "text-foreground" },
        { label: t("cacheWarmHitRate"), value: weightedWarmHitRate === null || weightedWarmHitRate === undefined ? "-" : `${Math.round(weightedWarmHitRate)}%`, tone: "text-foreground" },
        { label: t("cacheColCreation"), value: compactNumber(report.cacheCreationTokens), tone: "text-foreground" },
        { label: t("cacheColRead"), value: compactNumber(report.cacheReadTokens), tone: "text-foreground" },
      ];

  return (
    <section className="mt-6 border-t border-border pt-5" data-testid="cache-report">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="text-base font-semibold text-foreground">{t("cacheReportTitle")}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("cacheRequestProfile")}: {report.requestProfile ?? "-"}
            {report.baselineModel
              ? ` · ${compared ? t("cacheBaseline") : t("cacheReferenceProfile")}: ${report.baselineModel}`
              : ""}
          </p>
        </div>
        <span className={`self-start whitespace-nowrap text-sm font-semibold ${labelTone}`}>{scoreLabel}</span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-testid="cache-run-summary">
        {t("cacheCompletedRounds")}: {completedRounds}/{logicalRounds}
        {" · "}{t("cacheRequestAttempts")}: {requestAttempts}
        {" · "}{t("cacheObservedWarmRounds")}: {observedWarmRounds}/{requiredWarmRounds}
        {hasMultipleRuns && (
          <>
            {" · "}{t("cacheCompletedGroups")}: {completedRuns}/{requestedRuns}
            {" · "}{aggregation === "median" ? t("cacheAggregationMedian") : t("cacheAggregationSingle")}
          </>
        )}
        {report.requestProfilesUsed && report.requestProfilesUsed.length > 1
          ? ` · ${report.requestProfilesUsed.join(" → ")}`
          : ""}
      </p>

      {report.applicable && hasMultipleRuns && requestedRuns > 1 && completedRuns < requestedRuns && (
        <p className="mt-2 text-xs leading-relaxed text-warning" data-testid="cache-multi-run-warning">
          {t("cacheMultiRunIncomplete")}
        </p>
      )}
      {multiRunUnconfirmed && (
        <p className="mt-2 text-xs leading-relaxed text-warning" data-testid="cache-multi-run-unconfirmed">
          {t("cacheMultiRunUnconfirmedDetail")}
        </p>
      )}
      {report.applicable && hasMultipleRuns && completedRuns === requestedRuns && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t("cacheRepresentativeGroupNote")}
        </p>
      )}

      <dl className={`mt-4 grid grid-cols-2 border-y border-border ${compared ? "md:grid-cols-3 xl:grid-cols-6" : "md:grid-cols-5"}`}>
        {metrics.map((metric, index) => (
          <div
            key={metric.label}
            className={`min-w-0 px-3 py-3 ${index % 2 === 1 ? "border-l border-border" : ""} md:border-l md:first:border-l-0`}
          >
            <dt className="truncate text-[11px] text-muted-foreground">{metric.label}</dt>
            <dd className={`mt-1 font-mono text-lg font-semibold ${metric.tone}`}>{metric.value}</dd>
          </div>
        ))}
      </dl>

      {report.applicable && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {compared
            ? t("cacheComparableBaseline")
            : report.baselineSource === "official-alias" && fableObservation
              ? t("cacheFableBaselineReference")
              : report.baselineSource === "official-canonical" && report.baselineAvailable
                ? t("cacheTemplateReferenceOnly")
                : t("cacheNoIndependentBaseline")}
        </p>
      )}
      {(compared && report.comparisonAssumption === "missing_usage_treated_as_zero") ||
        (compared && report.observedWarmRounds === 0 && completedRounds >= logicalRounds) ? (
        <p className="mt-2 text-xs leading-relaxed text-warning">{t("cacheMissingFieldsComparedAsZero")}</p>
      ) : null}
      {!compared && completedRounds >= logicalRounds && report.evidenceFields.length === 0 && (
        <p className="mt-2 text-xs leading-relaxed text-warning">{t("cacheNoEvidence")}</p>
      )}
      {report.failureDetail && !(hasMultipleRuns && report.status === "incomplete" && report.failureDetail === t("cacheMultiRunIncomplete")) && (
        <p className="mt-2 break-words text-xs leading-relaxed text-error">{report.failureDetail}</p>
      )}

      {report.rounds.length > 0 && (
        <details className="group mt-4 border-t border-border pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground">
            <span>{t("cacheDetails")}</span>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-2 py-2 font-medium">{t("cacheColRound")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("cacheColInput")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("cacheColOutput")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("cacheColCreation")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("cacheColRead")}</th>
                  <th className="px-2 py-2 text-right font-medium">{t("cacheColWeighted")}</th>
                  {compared && <th className="px-2 py-2 text-right font-medium">{t("cacheOverallMultiplier")}</th>}
                  {compared && <th className="px-2 py-2 text-right font-medium">{t("cacheColAssessment")}</th>}
                </tr>
              </thead>
              <tbody>
                {report.rounds.map((round) => (
                  <tr key={round.round} className="border-b border-border last:border-0">
                    <td className="px-2 py-2 font-mono text-foreground">{round.round}</td>
                    <td className="px-2 py-2 text-right font-mono text-foreground">{round.inputTokens}{deltaText(round.inputDeltaPct)}</td>
                    <td className="px-2 py-2 text-right font-mono text-foreground">{round.outputTokens}{deltaText(round.outputDeltaPct)}</td>
                    <td className="px-2 py-2 text-right font-mono text-foreground">{round.cacheCreationTokens}{deltaText(round.cacheCreationDeltaPct)}</td>
                    <td className="px-2 py-2 text-right font-mono text-foreground">{round.cacheReadTokens}{deltaText(round.cacheReadDeltaPct)}</td>
                    <td className="px-2 py-2 text-right font-mono text-foreground">{compactNumber(round.measuredWeighted)}</td>
                    {compared && <td className={`px-2 py-2 text-right font-mono ${multiplierTone(round.multiplier)}`}>{round.multiplier === null || round.multiplier === undefined ? "-" : `${Number(round.multiplier.toFixed(2))}x`}</td>}
                    {compared && <td className={`px-2 py-2 text-right font-medium ${multiplierTone(round.multiplier)}`}>{roundAssessment(round, t)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {compared && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t("cacheBillingFormula")}</p>}
        </details>
      )}

      {hasMultipleRuns && groupReports.length > 0 && (
        <section className="mt-4 border-t border-border pt-3" data-testid="cache-group-details">
          <h5 className="text-sm font-medium text-foreground">{t("cacheGroupDetails")}</h5>
          <div className="mt-2 divide-y divide-border border-y border-border">
            {groupReports.map((group, index) => {
              const groupRounds = group.completedRounds ?? group.rounds.length;
              const groupLogicalRounds = group.logicalRounds ?? 5;
              const groupComplete = groupRounds >= groupLogicalRounds && group.status !== "failed" && group.status !== "partial" && group.status !== "incomplete";
              const groupScore = group.baselineComparison === "compared" ? group.compatibilityScore : null;
              return (
                <details key={`cache-group-${index}`} className="group/cache-group py-2">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs text-foreground">
                    <span className="font-medium">{t("cacheGroupLabel").replace("{index}", String(index + 1))}</span>
                    <span className="ml-auto font-mono text-muted-foreground">
                      {groupRounds}/{groupLogicalRounds}
                      {groupScore === null || groupScore === undefined ? " · -" : ` · ${groupScore}/100`}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open/cache-group:rotate-180" />
                  </summary>
                  <div className="mt-2 space-y-1 text-xs leading-relaxed text-muted-foreground">
                    <p>
                      {groupComplete
                        ? t("cacheCompletedRounds")
                        : t("cacheGroupIncomplete")}
                      {" · "}{t("cacheObservedWarmRounds")}: {group.observedWarmRounds ?? 0}/{group.requiredWarmRounds ?? Math.max(0, groupLogicalRounds - 1)}
                    </p>
                    {group.failureDetail && (
                      <p className="break-words text-error">{group.failureDetail}</p>
                    )}
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[680px] border-collapse text-[11px]">
                        <thead>
                          <tr className="border-b border-border text-left text-muted-foreground">
                            <th className="px-2 py-1.5 font-medium">{t("cacheColRound")}</th>
                            <th className="px-2 py-1.5 text-right font-medium">{t("cacheColInput")}</th>
                            <th className="px-2 py-1.5 text-right font-medium">{t("cacheColOutput")}</th>
                            <th className="px-2 py-1.5 text-right font-medium">{t("cacheColCreation")}</th>
                            <th className="px-2 py-1.5 text-right font-medium">{t("cacheColRead")}</th>
                            <th className="px-2 py-1.5 text-right font-medium">{t("cacheColWeighted")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.rounds.map((round) => (
                            <tr key={round.round} className="border-b border-border last:border-0">
                              <td className="px-2 py-1.5 font-mono text-foreground">{round.round}</td>
                              <td className="px-2 py-1.5 text-right font-mono text-foreground">{round.inputTokens}</td>
                              <td className="px-2 py-1.5 text-right font-mono text-foreground">{round.outputTokens}</td>
                              <td className="px-2 py-1.5 text-right font-mono text-foreground">{round.cacheCreationTokens}</td>
                              <td className="px-2 py-1.5 text-right font-mono text-foreground">{round.cacheReadTokens}</td>
                              <td className="px-2 py-1.5 text-right font-mono text-foreground">{compactNumber(round.measuredWeighted)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}
