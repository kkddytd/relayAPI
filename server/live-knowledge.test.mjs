import { describe, expect, it } from "vitest";
import {
  buildLiveKnowledgeQuestions,
  LIVE_KNOWLEDGE_QUESTION_TARGET,
} from "./live-knowledge.mjs";

function article(title) {
  return { title: title.replace(/ /g, "_"), titles: { normalized: title } };
}

describe("Wikimedia live-knowledge question generation", () => {
  it("fills a missing most-read field with another current-news fact", () => {
    const questions = buildLiveKnowledgeQuestions({
      news: [
        { links: [article("Current Event One"), article("Current Place")] },
        { links: [article("Current Event Two")] },
      ],
      tfa: article("Featured Topic"),
      onthisday: [{ year: 2018 }],
    });

    expect(questions).toHaveLength(LIVE_KNOWLEDGE_QUESTION_TARGET);
    expect(questions.map((question) => question.expected)).toEqual([
      "Current Event One",
      "Featured Topic",
      "2018",
      "Current Event Two",
    ]);
    expect(questions[3].sourcePath).toBe("news[1].links[0].titles.normalized");
  });

  it("records actual indexes when earlier source entries are unusable", () => {
    const questions = buildLiveKnowledgeQuestions({
      news: [{ links: [] }, { links: [article("Usable News"), article("Second Link")] }],
      tfa: article("Featured Topic"),
      onthisday: [{ text: "missing year" }, { year: 2016 }, { year: 2018 }],
    });

    expect(questions[0].sourcePath).toBe("news[1].links[0].titles.normalized");
    expect(questions.find((question) => question.expected === "2016")?.sourcePath).toBe("onthisday[1].year");
    expect(questions).toHaveLength(4);
  });

  it("deduplicates repeated facts before using fallback questions", () => {
    const questions = buildLiveKnowledgeQuestions({
      news: [{ links: [article("Same Topic"), article("Fallback Topic")] }],
      mostread: { articles: [article("Same Topic"), article("Other Topic")] },
      tfa: article("Featured Topic"),
      onthisday: [{ year: 2018 }],
    });

    expect(questions).toHaveLength(4);
    expect(questions.filter((question) => question.expected === "Same Topic")).toHaveLength(1);
    expect(new Set(questions.map((question) => `${question.kind}:${question.expected}`)).size).toBe(4);
  });
});
