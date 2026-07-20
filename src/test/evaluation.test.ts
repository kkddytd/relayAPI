import { describe, expect, it } from "vitest";
import {
  createGptQuizPrompt,
  createEvaluationSeed,
  createEvaluationSuite,
  getEvaluationProfile,
  gradeEvaluation,
  knowledgeAnswerMatches,
} from "@/lib/evaluation";
import {
  calculateAuthenticityScore,
  calculateCapabilityScore,
} from "@/lib/scoring";
import { extractCacheUsage, getCacheBaseline, summarizeCacheRounds } from "@/lib/cache";
import { MODELS } from "@/lib/models";

function allCorrectStage1(suite: ReturnType<typeof createEvaluationSuite>): string {
  return JSON.stringify({
    reasoning: suite.expected.reasoning,
    coding: suite.expected.coding,
    instruction: suite.expected.instruction,
    chinese: suite.expected.chinese,
    knowledge: suite.knowledgeQuestions.map((question) => question.answer),
    memory_ack: "READY",
  });
}

describe("model-specific evaluation", () => {
  it("keeps randomized suites deterministic for a fixed seed", () => {
    const first = createEvaluationSuite("gpt-5.6-sol", 20260713);
    const second = createEvaluationSuite("gpt-5.6-sol", 20260713);
    expect(first.stage1Prompt).toBe(second.stage1Prompt);
    expect(first.stage2Prompt).toBe(second.stage2Prompt);
    expect(first.memoryExpected).toBe(second.memoryExpected);
  });

  it("keeps generated capability probes stable for the same model and date", () => {
    const date = new Date(2026, 6, 15, 9, 0, 0);
    expect(createEvaluationSeed("claude-opus-4-8", date)).toBe(createEvaluationSeed("claude-opus-4-8", new Date(2026, 6, 15, 23, 59, 59)));
    expect(createEvaluationSeed("claude-opus-4-8", date)).not.toBe(createEvaluationSeed("claude-opus-4-7", date));
    const first = createEvaluationSuite("claude-opus-4-8", createEvaluationSeed("claude-opus-4-8", date), undefined, date);
    const second = createEvaluationSuite("claude-opus-4-8", createEvaluationSeed("claude-opus-4-8", date), undefined, new Date(2026, 6, 15, 23, 59, 59));
    expect(first.stage1Prompt).toBe(second.stage1Prompt);
    expect(first.extraProbes.map((probe) => probe.prompt)).toEqual(second.extraProbes.map((probe) => probe.prompt));
  });

  it("keeps the recent-knowledge batch stable within a calendar day", () => {
    const dayOne = new Date(2026, 6, 14, 9, 0, 0);
    const sameDayFirst = createEvaluationSuite("claude-fable-5", 1, undefined, dayOne);
    const sameDaySecond = createEvaluationSuite("claude-fable-5", 2, undefined, new Date(2026, 6, 14, 23, 59, 59));
    const nextDay = createEvaluationSuite("claude-fable-5", 2, undefined, new Date(2026, 6, 15, 0, 0, 1));

    expect(sameDayFirst.knowledgeBatchDate).toBe("2026-07-14");
    expect(sameDayFirst.knowledgeBatchId).toBe(sameDaySecond.knowledgeBatchId);
    expect(sameDayFirst.knowledgeQuestions.map((question) => question.id)).toEqual(
      sameDaySecond.knowledgeQuestions.map((question) => question.id),
    );
    expect(nextDay.knowledgeBatchId).not.toBe(sameDayFirst.knowledgeBatchId);
  });

  it("uses different profiles and knowledge requirements for model families", () => {
    const gpt = getEvaluationProfile("gpt-5.6-sol");
    const legacyClaude = getEvaluationProfile("claude-opus-4-6");
    const modernClaude = getEvaluationProfile("claude-opus-4-8");
    expect(gpt.authenticityStrategy).toBe("gpt");
    expect(legacyClaude.authenticityStrategy).toBe("claude-legacy");
    expect(modernClaude.authenticityStrategy).toBe("claude-modern");
    expect(gpt.knowledgeRequired).toBeGreaterThan(legacyClaude.knowledgeRequired);
    expect(getEvaluationProfile("claude-fable-5").cacheSupported).toBe(true);
    expect(getEvaluationProfile("claude-sonnet-5").cacheSupported).toBe(false);
    expect(getEvaluationProfile("claude-opus-4-8").cacheSupported).toBe(true);
    expect(getEvaluationProfile("claude-haiku-4-5").cacheSupported).toBe(false);
    expect(getEvaluationProfile("claude-custom-next").cacheSupported).toBe(false);
    expect(getEvaluationProfile("claude-opus-4-8-20260714", "claude-modern").probeFamily).toBe("claude-frontier");
    expect(getEvaluationProfile("fable5", "claude-modern").probeFamily).toBe("fable");
    expect(getEvaluationProfile("claude-5-fable", "claude-modern").probeFamily).toBe("fable");
  });

  it("keeps Claude Code model decorators on the model request without losing the built-in suite", () => {
    expect(getEvaluationProfile("claude-opus-4-8[1m]").id).toBe("claude-opus-4-8-frontier");
    expect(getEvaluationProfile("claude-opus-4-8[fast]").probeFamily).toBe("claude-frontier");
    expect(getCacheBaseline("claude-opus-4-8[1m]")).toHaveLength(5);
  });

  it("builds the official-style numbered GPT quiz separately from capability probes", () => {
    const suite = createEvaluationSuite("gpt-5.5", 20260713);
    const prompt = createGptQuizPrompt(suite.knowledgeQuestions);
    expect(prompt).toContain("只输出 5 行");
    expect(prompt).toContain("1.");
    expect(prompt).toContain("序号|答案");
    expect(suite.profile.knowledgeSet).toBe("official-gpt-april-2025");
    expect(suite.knowledgeQuestions.every((question) => /2025/.test(question.id))).toBe(true);
    expect(suite.knowledgeBatchDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getEvaluationProfile("gpt-5.6-luna").probeFamily).toBe("openai-compatible");
    expect(getEvaluationProfile("gpt-5.6-sol").probeFamily).toBe("gpt");
  });

  it("keeps official GPT prompt metadata and lower-bound answers aligned", () => {
    const suite = createEvaluationSuite("gpt-5.5", 17);
    const prompt = createGptQuizPrompt(suite.knowledgeQuestions);
    expect(prompt).toContain("要求:");
    expect(prompt).toMatch(/\[[^\]]+\]/);
    expect(prompt.split("\n").slice(0, 4)).toEqual([
      "请回答下面的近期知识题。",
      "只输出 5 行，每行严格使用“序号|答案”的格式，例如：1|22 people。",
      "不要输出标题、解释、分析或额外空行。",
      "",
    ]);
    const sumy = {
      id: "sumy-strike-2025-04-13",
      prompt: "",
      answer: "At least 35 people",
      aliases: ["at least 35", "35"],
    };
    expect(knowledgeAnswerMatches(sumy, "At least 36 people")).toBe(true);
    expect(knowledgeAnswerMatches(sumy, "At least 30 people")).toBe(true);
    expect(knowledgeAnswerMatches(sumy, "34 people")).toBe(false);
  });

  it("matches the public lower-bound checker", () => {
    const question = {
      id: "sumy-strike-2025-04-13",
      prompt: "",
      answer: "At least 35 people",
      aliases: ["at least 35", "35"],
    } as const;
    expect(knowledgeAnswerMatches(question, "100 people")).toBe(true);
    expect(knowledgeAnswerMatches(question, "30 people")).toBe(false);
    expect(knowledgeAnswerMatches(question, "at least 30 people")).toBe(true);
    expect(knowledgeAnswerMatches(question, "at least 35 people")).toBe(true);
  });

  it("builds Fable 5 with the official four-stage order and strict dynamic expectations", () => {
    const suite = createEvaluationSuite("claude-fable-5", 20260713);
    expect(suite.extraProbes.map((probe) => probe.id)).toEqual([
      "knowledge",
      "pdf",
      "calc",
      "model-feature",
    ]);
    expect(suite.extraProbes[0]?.thinkingMode).toBe("adaptive-omitted");
    expect(suite.extraProbes[0]?.anthropicEffort).toBe("xhigh");
    expect(suite.extraProbes[1]?.requestBeta).toBeUndefined();
    expect(suite.extraProbes[2]?.jsonSchema).toBeUndefined();
    expect(suite.extraProbes[2]?.expectedExpression).toMatch(/^\d+\*\d+$/);
    expect(suite.extraProbes[2]?.expectedResult).toBeTypeOf("number");
    expect(suite.extraProbes[0]?.prompt).toContain("例如：1|Alaska");
    expect(suite.extraProbes[0]?.prompt).toContain("1. Q:");
    expect(suite.extraProbes[0]?.prompt).not.toContain("不知道的题");
    expect(suite.extraProbes[1]?.prompt).toBe("What text does this PDF contain? 只给我返回文字,不要使用工具");
  });

  it("uses the current public Gemini fallback challenge wording", () => {
    const suite = createEvaluationSuite("gemini-3.1-pro-preview", 20260715);
    expect(suite.extraProbes[2]?.prompt).toContain("凭直觉回答, 不要思考.不要思考,不要思考.");
  });

  it("uses the current compatibility stage plans for the other dedicated Claude families", () => {
    const frontier = createEvaluationSuite("claude-opus-4-8", 20260713);
    expect(frontier.profile.probeFamily).toBe("claude-frontier");
    expect(frontier.profile.knowledgeRequired).toBe(1);
    expect(frontier.extraProbes.map((probe) => probe.id)).toEqual(["knowledge", "pdf", "calc", "signature"]);
    expect(frontier.extraProbes[2]?.jsonSchema).toBeDefined();
    expect(frontier.extraProbes[3]?.prompt).toMatch(/sha256 3次/);

    const standard = createEvaluationSuite("claude-sonnet-4-6", 20260713);
    expect(standard.profile.probeFamily).toBe("claude-standard");
    expect(standard.stage1Prompt).toContain("这个符号”");
    expect(standard.stage2Prompt).toContain("例如：1|Anora");
    expect(standard.stage2Prompt).toContain("不知道的题，回答 不知道");
    expect(standard.knowledgeQuestions).toHaveLength(4);
    expect(standard.profile.knowledgeRequired).toBe(1);
    expect(standard.extraProbes.map((probe) => probe.id)).toEqual(["pdf", "calc"]);
    expect(standard.extraProbes[0]?.prompt).toContain("What text does this PDF contain?");
    expect(standard.knowledgeQuestions.every((question) => question.id.includes("2025"))).toBe(true);
    expect(standard.knowledgeBatchId).toContain(standard.knowledgeBatchDate);
  });

  it("selects a real quality suite for arbitrary custom model IDs by endpoint family", () => {
    const customOpenAI = createEvaluationSuite("vendor/custom-chat", 7, "openai-compatible");
    const customAnthropic = createEvaluationSuite("vendor/custom-chat", 7, "claude-modern");
    const customGoogle = createEvaluationSuite("vendor/custom-chat", 7, "gemini");

    expect(customOpenAI.profile.probeFamily).toBe("openai-compatible");
    expect(customOpenAI.knowledgeQuestions).toHaveLength(0);
    expect(customOpenAI.stage1Prompt).toContain("逻辑推理");
    expect(customOpenAI.stage2Prompt).toContain("竹-松");
    expect(customAnthropic.profile.probeFamily).toBe("claude-standard");
    expect(customAnthropic.stage1Prompt).toContain("这个符号”");
    expect(customAnthropic.extraProbes.map((probe) => probe.id)).toEqual(["pdf", "calc"]);
    expect(customGoogle.profile.probeFamily).toBe("gemini");
    expect(customGoogle.extraProbes).toHaveLength(3);
    expect(getEvaluationProfile("vendor/custom-chat").probeFamily).toBe("liveness");
  });

  it("uses deterministic capability probes for legacy OpenAI-compatible models", () => {
    for (const model of ["o3", "o4-mini", "glm-5.2"]) {
      const suite = createEvaluationSuite(model, 7, "openai-compatible");
      expect(suite.profile.probeFamily).toBe("openai-compatible");
      expect(suite.knowledgeQuestions).toHaveLength(0);
      expect(suite.stage1Prompt).toContain("代码执行");
      expect(suite.stage2Prompt).toContain("偏移");
    }
  });

  it("uses the official GPT knowledge quiz only for dedicated public profiles", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4"]) {
      const suite = createEvaluationSuite(model, 7, "openai-compatible");
      expect(suite.profile.probeFamily, model).toBe("gpt");
      expect(suite.profile.knowledgeSet, model).toBe("official-gpt-april-2025");
      expect(suite.knowledgeQuestions).toHaveLength(5);
    }
  });

  it("uses cutoff-independent capability tasks for quality-only GPT profiles", () => {
    for (const model of ["gpt-5.6-luna", "gpt-5.6", "gpt-5", "gpt-4.1", "gpt-4o-mini", "gpt-private-v9"]) {
      const suite = createEvaluationSuite(model, 7, "openai-compatible");
      expect(suite.profile.probeFamily, model).toBe("openai-compatible");
      expect(suite.knowledgeQuestions, model).toHaveLength(0);
      expect(suite.stage1Prompt, model).toContain("代码执行");
      expect(suite.stage2Prompt, model).toContain("偏移");
    }
  });

  it("never falls back to liveness-only checks for a listed text model", () => {
    const textModels = MODELS.filter((model) => model.capability === "chat");
    expect(textModels.length).toBeGreaterThan(0);
    for (const model of textModels) {
      expect(getEvaluationProfile(model.id).probeFamily, model.id).not.toBe("liveness");
    }
  });

  it("randomizes Claude calculation probes while keeping exact validators", () => {
    const suite = createEvaluationSuite("claude-opus-4-8", 20260713);
    const calc = suite.extraProbes.find((probe) => probe.id === "calc");
    expect(calc).toBeDefined();
    const values = calc?.prompt.match(/计算 (\d+) 乘以 (\d+)/);
    expect(values).not.toBeNull();
    const a = Number(values?.[1]);
    const b = Number(values?.[2]);
    const response = JSON.stringify({ expression: `${a}*${b}`, result: a * b });
    expect(calc?.acceptedPatterns.every((pattern) => pattern.test(response))).toBe(true);
    expect(calc?.jsonSchema).toBeDefined();
  });

  it("grades partial knowledge separately from the five capability dimensions", () => {
    const suite = createEvaluationSuite("gpt-5.5", 7);
    const correct = gradeEvaluation(allCorrectStage1(suite), suite.memoryExpected, suite);
    expect(correct.knowledge).toBe(true);
    expect(correct.knowledgeCorrectCount).toBe(suite.knowledgeQuestions.length);
    expect(correct.reasoning).toBe(true);

    const partial = gradeEvaluation(
      JSON.stringify({
        reasoning: suite.expected.reasoning,
        coding: "wrong",
        instruction: suite.expected.instruction,
        chinese: suite.expected.chinese,
        knowledge: [suite.knowledgeQuestions[0]?.answer ?? "wrong"],
        memory_ack: "READY",
      }),
      "wrong",
      suite,
    );
    expect(partial.knowledgeCorrectCount).toBe(1);
    expect(partial.knowledge).toBe(false);
    expect(partial.coding).toBe(false);
    expect(partial.memory).toBe(false);
  });

  it("keeps generated capability answers self-consistent across random seeds", () => {
    for (const model of ["o3", "vendor/custom-chat"]) {
      for (let seed = 0; seed < 100; seed += 1) {
        const suite = createEvaluationSuite(model, seed, "openai-compatible");
        const grades = gradeEvaluation(allCorrectStage1(suite), suite.memoryExpected, suite);
        expect(grades.reasoning, `${model} seed ${seed}`).toBe(true);
        expect(grades.coding, `${model} seed ${seed}`).toBe(true);
        expect(grades.instruction, `${model} seed ${seed}`).toBe(true);
        expect(grades.chinese, `${model} seed ${seed}`).toBe(true);
        expect(grades.memory, `${model} seed ${seed}`).toBe(true);
      }
    }
  });

  it("does not treat prose around the JSON answer as valid JSON output", () => {
    const suite = createEvaluationSuite("o3", 7, "openai-compatible");
    const payload = allCorrectStage1(suite);
    const noisy = gradeEvaluation(`Here is the result:\n${payload}\nDone.`, suite.memoryExpected, suite);
    expect(noisy.jsonFormat).toBe(false);
    expect(noisy.instruction).toBe(false);
  });

  it("rejects refusal text and compares numeric answers as complete values", () => {
    const tariff = { id: "us-china-total-tariff-2025-04-10", prompt: "", answer: "145%", aliases: ["145"] };
    const gaza = { id: "gaza-death-toll-2025-04-27", prompt: "", answer: "52,243", aliases: ["52243"] };
    expect(knowledgeAnswerMatches(tariff, "I don't know, maybe 145%")).toBe(false);
    expect(knowledgeAnswerMatches(gaza, "52,243 people")).toBe(true);
    expect(knowledgeAnswerMatches(gaza, "1,052,243 people")).toBe(false);
  });

  it("changes authenticity and overall scores when identity or knowledge signals fail", () => {
    const profile = getEvaluationProfile("gpt-5.5");
    const pass = calculateAuthenticityScore(profile, {
      knowledge: "pass",
      identity: "pass",
      protocol: "pass",
      structure: "pass",
      thinking: "warning",
      signature: "warning",
    });
    const suspicious = calculateAuthenticityScore(profile, {
      knowledge: "fail",
      identity: "fail",
      protocol: "pass",
      structure: "pass",
      thinking: "warning",
      signature: "warning",
    });
    expect(pass.score).toBeGreaterThan(suspicious.score);
    expect(calculateCapabilityScore({
      reasoning: true,
      coding: true,
      instruction: true,
      chinese: true,
      memory: true,
      knowledge: true,
      knowledgeCorrectCount: 4,
      knowledgeRequired: 3,
      knowledgeResults: [],
      jsonFormat: true,
      actual: {},
      memoryActual: "",
    })).toBe(100);
    expect(calculateCapabilityScore({
      reasoning: true,
      coding: false,
      instruction: false,
      chinese: false,
      memory: false,
      knowledge: false,
      knowledgeCorrectCount: 0,
      knowledgeRequired: 1,
      knowledgeResults: [],
      jsonFormat: false,
      actual: {},
      memoryActual: "",
    }, getEvaluationProfile("gpt-5.5"))).toBe(26);
  });

  it("requires provider token evidence before confirming prompt cache", () => {
    expect(extractCacheUsage({ input_tokens: 20, output_tokens: 4 }).evidenceFields).toEqual([]);
    const openAIUsage = extractCacheUsage({ prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } });
    expect(openAIUsage.evidenceFields).toContain("prompt_tokens_details.cached_tokens");
    expect(openAIUsage.cacheReadTokens).toBe(0);
    const noEvidence = summarizeCacheRounds(Array.from({ length: 5 }, (_, index) => ({
      round: index + 1,
      latencyMs: 1,
      inputTokens: 20,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      hitRate: 0,
      evidence: false,
    })));
    expect(noEvidence.status).toBe("unobserved");
    expect(getCacheBaseline("claude-opus-4-6")?.[0]).toEqual({ input: 3, output: 22, cacheCreation: 4656, cacheRead: 0 });
  });
});
