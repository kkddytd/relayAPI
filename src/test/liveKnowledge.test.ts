import { describe, expect, it } from "vitest";
import {
  createLiveKnowledgePrompt,
  gradeLiveKnowledge,
  isLiveKnowledgeSnapshot,
  liveKnowledgeAnswerMatches,
  liveKnowledgeGradePasses,
  type LiveKnowledgeSnapshot,
} from "@/lib/liveKnowledge";

const snapshot: LiveKnowledgeSnapshot = {
  schemaVersion: 2,
  snapshotId: "wikimedia-test",
  generatedAt: "2026-07-14T00:00:00.000Z",
  sourceDate: "2026-07-14",
  sourceName: "Wikimedia featured feed (English)",
  sourceUrl: "https://example.invalid/feed",
  sourceRevision: "123",
  requiredCorrect: 2,
  cache: { status: "miss", ageSeconds: 0, ttlSeconds: 900 },
  questions: [
    {
      id: "title",
      prompt: "What is the title?",
      kind: "text",
      expected: "Sam Neill",
      aliases: ["Sam_Neill"],
      sourcePath: "mostread.articles[0]",
    },
    {
      id: "year",
      prompt: "What year?",
      kind: "number",
      expected: "2016",
      aliases: ["2016"],
      sourcePath: "onthisday[0].year",
    },
  ],
};

describe("live knowledge snapshots", () => {
  it("matches title aliases and exact numeric facts", () => {
    expect(liveKnowledgeAnswerMatches(snapshot.questions[0], "The answer is Sam_Neill.")).toBe(true);
    expect(liveKnowledgeAnswerMatches(snapshot.questions[1], "2016")).toBe(true);
    expect(liveKnowledgeAnswerMatches(snapshot.questions[1], "2017")).toBe(false);
    expect(liveKnowledgeAnswerMatches(snapshot.questions[1], "not 2018, maybe 2017")).toBe(false);
  });

  it("does not match a short title inside an unrelated word", () => {
    const shortTitle = { ...snapshot.questions[0], expected: "Psy", aliases: ["Psy"] };
    expect(liveKnowledgeAnswerMatches(shortTitle, "Psy")).toBe(true);
    expect(liveKnowledgeAnswerMatches(shortTitle, "psychology")).toBe(false);
  });

  it("does not count explicitly negated facts as live-knowledge hits", () => {
    expect(liveKnowledgeAnswerMatches(snapshot.questions[0], "The answer is not Sam Neill")).toBe(false);
    expect(liveKnowledgeAnswerMatches(snapshot.questions[0], "不是 Sam Neill")).toBe(false);
    expect(liveKnowledgeAnswerMatches(snapshot.questions[1], "not 2016")).toBe(false);
    expect(liveKnowledgeAnswerMatches(snapshot.questions[1], "并非 2016")).toBe(false);
  });

  it("grades numbered output without changing the fixed quality score", () => {
    const grade = gradeLiveKnowledge(snapshot, "1|Sam Neill\n2|2016");
    expect(grade).toMatchObject({ correct: 2, total: 2, score: 100 });
    expect(createLiveKnowledgePrompt(snapshot)).toContain("1|What is the title?");
    expect(createLiveKnowledgePrompt(snapshot)).toContain(snapshot.sourceUrl);
    expect(createLiveKnowledgePrompt(snapshot)).not.toContain("Sam Neill");
    expect(liveKnowledgeGradePasses(snapshot, grade)).toBe(true);
  });

  it("rejects explicit uncertainty instead of counting it as a hit", () => {
    expect(liveKnowledgeAnswerMatches(snapshot.questions[0], "I don't know")).toBe(false);
    expect(liveKnowledgeAnswerMatches(snapshot.questions[0], "I don't have access to live data")).toBe(false);
    expect(liveKnowledgeAnswerMatches(snapshot.questions[1], "I don't know, perhaps 2016")).toBe(false);
  });

  it("separates no-live-access refusals from wrong factual answers", () => {
    const grade = gradeLiveKnowledge(snapshot, "1|无法确定，我没有实时数据\n2|2017");
    expect(grade.abstained).toBe(1);
    expect(grade.results[0]?.classification).toBe("abstained");
    expect(grade.results[1]?.classification).toBe("wrong");
  });

  it("uses the snapshot threshold instead of deriving one from the question count", () => {
    const fourQuestionSnapshot: LiveKnowledgeSnapshot = {
      ...snapshot,
      requiredCorrect: 3,
      questions: [
        ...snapshot.questions,
        { ...snapshot.questions[0], id: "title-2", expected: "Cognition", aliases: ["Cognition"] },
        { ...snapshot.questions[1], id: "year-2", expected: "2018", aliases: ["2018"] },
      ],
    };
    const grade = gradeLiveKnowledge(fourQuestionSnapshot, "1|Sam Neill\n2|2016\n3|Cognition\n4|wrong");
    expect(liveKnowledgeGradePasses(fourQuestionSnapshot, grade)).toBe(true);
  });

  it("rejects old and incomplete snapshot contracts", () => {
    const completeSnapshot = {
      ...snapshot,
      requiredCorrect: 3,
      questions: [
        ...snapshot.questions,
        { ...snapshot.questions[0], id: "title-2" },
        { ...snapshot.questions[1], id: "year-2" },
      ],
    };
    expect(isLiveKnowledgeSnapshot(completeSnapshot)).toBe(true);
    expect(isLiveKnowledgeSnapshot({ ...completeSnapshot, schemaVersion: 1 })).toBe(false);
    expect(isLiveKnowledgeSnapshot({ ...completeSnapshot, requiredCorrect: 5 })).toBe(false);
    expect(isLiveKnowledgeSnapshot({ ...completeSnapshot, questions: completeSnapshot.questions.slice(0, 3) })).toBe(false);
  });
});
