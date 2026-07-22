// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryLog, type HistoryEntry } from "@/components/HistoryLog";
import { I18nProvider } from "@/i18n";

afterEach(cleanup);

const entry: HistoryEntry = {
  id: "history-1",
  timestamp: "2026-07-21 12:00:00",
  model: "gpt-test",
  endpoint: "https://api.example.com",
  apiKey: "",
  score: 90,
  status: "consistent",
  attachments: [{
    id: "att_11111111111111111111111111111111",
    name: "report.json",
    url: "/upload/report.json",
  }],
};

describe("HistoryLog attachments", () => {
  it("opens persisted attachment URLs from an expanded history row", () => {
    render(
      <I18nProvider>
        <HistoryLog entries={[entry]} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button"));
    const link = screen.getByRole("link", { name: "report.json" });
    expect(link.getAttribute("href")).toBe("/upload/report.json");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
