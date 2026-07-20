// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentAnalysisPanel } from "@/components/AttachmentAnalysisPanel";
import { I18nProvider } from "@/i18n";
import type { AttachmentAnalysisReport } from "@/lib/attachments";

afterEach(cleanup);

function renderReport(item: AttachmentAnalysisReport["items"][number]) {
  const report: AttachmentAnalysisReport = {
    requested: true,
    status: item.status === "completed" ? "completed" : "failed",
    scored: false,
    affects_primary_score: false,
    completed: item.status === "completed" ? 1 : 0,
    total: 1,
    items: [item],
  };
  render(
    <I18nProvider>
      <AttachmentAnalysisPanel report={report} />
    </I18nProvider>,
  );
}

describe("AttachmentAnalysisPanel", () => {
  it("shows an attachment URL with a not-recognized result", () => {
    renderReport({
      attachment_id: "generated-003.png",
      name: "generated-003.png",
      url: "/upload/generated-003.png",
      status: "failed",
      recognition_status: "not-recognized",
      recognition_reason: "model_did_not_observe_attachment",
      requested_model: "claude-fable-5",
      analysis_model: "claude-opus-4-8",
      analysis: null,
      error: "attachment_not_observed_by_model",
    });

    expect(screen.getAllByText("未识别附件").length).toBeGreaterThan(0);
    expect(screen.getByText("识别结果: 0/1")).not.toBeNull();
    expect(screen.getByRole("link", { name: /upload\/generated-003\.png/ }).getAttribute("href")).toBe("/upload/generated-003.png");
    expect(screen.getByText("附件测试只判断模型能否识别附件，不参与模型主评分。")).not.toBeNull();
    expect(screen.queryByTestId("attachment-fallback-disclosure")).toBeNull();
  });

  it("shows only the recognized result and attachment URL", () => {
    renderReport({
      attachment_id: "generated-003.png",
      name: "generated-003.png",
      url: "/upload/generated-003.png",
      status: "completed",
      recognition_status: "recognized",
      recognition_reason: "model_returned_grounded_attachment_observation",
      requested_model: "claude-fable-5",
      analysis_model: "claude-opus-4-8",
      analysis: null,
      error: null,
    });

    expect(screen.getByText("已识别附件")).not.toBeNull();
    expect(screen.getByText("识别结果: 1/1")).not.toBeNull();
    expect(screen.getByRole("link", { name: /upload\/generated-003\.png/ }).getAttribute("href")).toBe("/upload/generated-003.png");
  });

  it("keeps legacy history readable without restoring intent or verification claims", () => {
    renderReport({
      attachment_id: "legacy.json",
      name: "legacy.json",
      url: "/upload/legacy.json",
      status: "completed",
      delivery_mode: "extracted",
      coverage_percent: 100,
      analysis: {
        observable_content: "Readable JSON configuration",
        likely_purpose: "Configure a production payment service",
        evidence: ["A service key is present"],
      },
      verification: {
        status: "match",
        matched_ratio: 1,
      },
    });

    expect(screen.getByText("已识别附件")).not.toBeNull();
    expect(screen.getByRole("link", { name: /upload\/legacy\.json/ }).getAttribute("href")).toBe("/upload/legacy.json");
    expect(screen.queryByText("Configure a production payment service")).toBeNull();
    expect(screen.queryByText("符合预期")).toBeNull();
  });
});
