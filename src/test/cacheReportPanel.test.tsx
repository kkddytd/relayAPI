// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CacheReportPanel } from "@/components/CacheReportPanel";
import { I18nProvider } from "@/i18n";
import type { CacheReport } from "@/lib/cache";

afterEach(cleanup);

const baseReport: CacheReport = {
  applicable: true,
  status: "confirmed",
  rounds: [],
  evidenceFields: ["cache_read_input_tokens"],
  cacheReadTokens: 100,
  cacheCreationTokens: 50,
  hitRate: 80,
  warmHitRate: 80,
  evidenceSufficient: true,
  baselineModel: null,
  baselineSource: null,
  baselineAvailable: false,
  baselineComparison: "none",
  requestProfile: "custom",
};

function renderReport(report: CacheReport) {
  render(
    <I18nProvider>
      <CacheReportPanel report={report} />
    </I18nProvider>,
  );
}

describe("CacheReportPanel", () => {
  it("shows the concrete not-applicable reason instead of a completed miss", () => {
    renderReport({
      ...baseReport,
      applicable: false,
      reason: "protocol_not_supported",
      status: "unconfirmed",
      rounds: [],
    });

    expect(screen.getByText("当前接口协议不是 Anthropic，无法发起提示缓存检测")).not.toBeNull();
    expect(screen.queryByText("五轮完成，预热轮次证据不足或未持续读取")).toBeNull();
  });

  it("prioritizes an upstream-unavailable reason for an applicable but failed run", () => {
    renderReport({
      ...baseReport,
      status: "failed",
      reason: "upstream_unavailable",
      completedRounds: 0,
      logicalRounds: 5,
      requestAttempts: 1,
    });

    expect(screen.getByText(/不能把未完成轮次当成缓存未命中/)).not.toBeNull();
    expect(screen.queryByText("缓存检测请求失败")).toBeNull();
  });

  it("uses Fable-specific copy only for a Fable observation", () => {
    const aliasReport: CacheReport = {
      ...baseReport,
      observationModel: "claude-sonnet-5",
      baselineModel: "claude-sonnet-4-6",
      baselineSource: "official-alias",
      baselineAvailable: true,
      baselineComparison: "reference-only",
    };
    renderReport(aliasReport);

    expect(screen.queryByText(/Fable 已完整执行/)).toBeNull();
    expect(screen.getByText(/没有该模型的独立官网基线/)).not.toBeNull();

    cleanup();
    renderReport({ ...aliasReport, observationModel: "claude-fable-5", baselineModel: "claude-opus-4-8" });
    expect(screen.getByText(/Fable 已完整执行 5 个逻辑轮次/)).not.toBeNull();
  });

  it("labels arithmetic and token-weighted warm hit rates separately", () => {
    renderReport({ ...baseReport, hitRate: 75, warmHitRate: 82 });

    expect(screen.getByText("预热轮次算术平均命中率")).not.toBeNull();
    expect(screen.getByText("预热轮次 Token 加权命中率")).not.toBeNull();
    expect(screen.getByText("75%")).not.toBeNull();
    expect(screen.getByText("82%")).not.toBeNull();
  });

  it("separates logical rounds, actual attempts, and warm evidence coverage", () => {
    renderReport({
      ...baseReport,
      completedRounds: 5,
      logicalRounds: 5,
      requestAttempts: 6,
      requestProfilesUsed: ["custom", "claude_code"],
      observedWarmRounds: 2,
      requiredWarmRounds: 4,
    });

    const summary = screen.getByTestId("cache-run-summary").textContent ?? "";
    expect(summary).toContain("已完成逻辑轮次: 5/5");
    expect(summary).toContain("实际请求次数: 6");
    expect(summary).toContain("预热缓存证据: 2/4");
    expect(summary).toContain("custom → claude_code");
  });

  it("warns when the public comparison assumes zero warm reads", () => {
    renderReport({
      ...baseReport,
      status: "unobserved",
      baselineComparison: "compared",
      compatibilityScore: 0,
      comparisonHitRate: 0,
      comparisonAssumption: "missing_usage_treated_as_zero",
      completedRounds: 5,
      logicalRounds: 5,
      observedWarmRounds: 0,
      requiredWarmRounds: 4,
    });

    expect(screen.getByText(/四个预热轮次没有可用的缓存 token 字段/)).not.toBeNull();
  });

  it("keeps unconfirmed status visible as a warning and recognizes Fable aliases", () => {
    renderReport({
      ...baseReport,
      status: "unconfirmed",
      observationModel: "fable5",
      baselineModel: "claude-opus-4-8",
      baselineSource: "official-alias",
      baselineAvailable: true,
      baselineComparison: "reference-only",
      compatibilityScore: null,
    });

    const status = screen.getByText("五轮完成，预热轮次证据不足或未持续读取");
    expect(status.className).toContain("text-warning");
    expect(screen.getByText(/Fable 已完整执行 5 个逻辑轮次/)).not.toBeNull();
  });

  it("does not label a mixed multi-group median as a confirmed cache result", () => {
    const confirmedGroup: CacheReport = {
      ...baseReport,
      status: "confirmed",
      completedRounds: 5,
      logicalRounds: 5,
      observedWarmRounds: 4,
      requiredWarmRounds: 4,
      baselineComparison: "compared",
      compatibilityScore: 100,
    };
    const unobservedGroup: CacheReport = {
      ...confirmedGroup,
      status: "unobserved",
      observedWarmRounds: 0,
      compatibilityScore: 0,
      comparisonAssumption: "missing_usage_treated_as_zero",
    };
    renderReport({
      ...confirmedGroup,
      status: "unconfirmed",
      compatibilityScore: 50,
      requestedRuns: 2,
      completedRuns: 2,
      aggregation: "median",
      runs: [confirmedGroup, unobservedGroup],
    });

    expect(screen.getByText("多组缓存证据未稳定")).not.toBeNull();
    expect(screen.getByTestId("cache-multi-run-unconfirmed").textContent).toContain("至少一组没有持续返回四个预热轮次");
    expect(screen.getByText(/顶部五轮明细为代表组/)).not.toBeNull();
    expect(screen.queryByTestId("cache-multi-run-warning")).toBeNull();
  });
});
