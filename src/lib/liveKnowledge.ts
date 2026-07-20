export type LiveKnowledgeQuestionKind = "text" | "number";

export interface LiveKnowledgeQuestion {
  id: string;
  prompt: string;
  kind: LiveKnowledgeQuestionKind;
  expected: string;
  aliases: string[];
  sourcePath: string;
}

export interface LiveKnowledgeCacheInfo {
  status: "miss" | "hit" | "stale";
  ageSeconds: number;
  ttlSeconds: number;
}

export interface LiveKnowledgeSnapshot {
  schemaVersion: 2;
  snapshotId: string;
  generatedAt: string;
  sourceDate: string;
  sourceName: string;
  sourceUrl: string;
  sourceRevision: string | null;
  requiredCorrect: number;
  cache: LiveKnowledgeCacheInfo;
  questions: LiveKnowledgeQuestion[];
}

export interface LiveKnowledgeGrade {
  correct: number;
  abstained: number;
  total: number;
  score: number;
  results: Array<{
    id: string;
    expected: string;
    actual: string;
    passed: boolean;
    classification: "correct" | "wrong" | "abstained";
  }>;
}

const ABSTENTION_PATTERNS = [
  /^不知道$/i,
  /^不清楚$/i,
  /^无法确定$/i,
  /^无法回答$/i,
  /没有实时数据/iu,
  /没有实时数据访问能力/iu,
  /无法获知当前/iu,
  /无法获取当前/iu,
  /无法获取今日/iu,
  /无法.*实时.*(?:数据|信息|内容)/iu,
  /(?:no|without)\s+access\s+to\s+(?:live|real[\s-]?time)\s+(?:data|information)/i,
  /(?:cannot|can't|unable\s+to)\s+(?:access|retrieve|obtain)\s+(?:live|real[\s-]?time)\s+(?:data|information)/i,
  /(?:don't|do not)\s+have\s+(?:access\s+to\s+)?(?:live|real[\s-]?time)\s+(?:data|information)/i,
  /^unknown$/i,
  /^not\s+sure$/i,
  /^i\s+(?:do\s+not|don't)\s+know$/i,
  /\b(?:i\s+(?:do\s+not|don\s+t)\s+know|unknown|not\s+sure)\b/i,
  /\b(?:cannot|can't|unable\s+to)\b[^.!?\n]{0,80}\b(?:answer|access|retrieve|obtain|know)\b/i,
  /(?:无法|不能|没有|未能)[^。！？\n]{0,40}(?:回答|访问|获取|确定|知道)/u,
];

export function normalizeLiveAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isLiveKnowledgeAbstention(value: string): boolean {
  const normalized = normalizeLiveAnswer(value);
  return !normalized || ABSTENTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function numberValues(value: string): number[] {
  return (normalizeLiveAnswer(value).match(/\d+(?:\.\d+)?/g) ?? [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function candidateIsNegated(normalizedAnswer: string, candidate: string): boolean {
  const answerTokens = normalizedAnswer.split(/\s+/).filter(Boolean);
  const candidateTokens = candidate.split(/\s+/).filter(Boolean);
  if (candidateTokens.length === 0 || answerTokens.length < candidateTokens.length) return false;

  const negators = new Set(["not", "no", "never", "incorrect", "wrong", "isnt", "isn", "wasnt", "wasn"]);
  for (let index = 0; index <= answerTokens.length - candidateTokens.length; index += 1) {
    if (!candidateTokens.every((token, offset) => answerTokens[index + offset] === token)) continue;
    if (answerTokens.slice(Math.max(0, index - 4), index).some((token) => negators.has(token))) return true;
  }

  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Boolean(escaped && new RegExp(`(?:不是|并非|非|不)\\s*${escaped}`, "u").test(normalizedAnswer));
}

export function liveKnowledgeAnswerMatches(question: LiveKnowledgeQuestion, value: string): boolean {
  if (isLiveKnowledgeAbstention(value)) return false;
  const normalized = normalizeLiveAnswer(value);
  if (question.kind === "number") {
    const expected = Number(normalizeLiveAnswer(question.expected));
    if (candidateIsNegated(normalized, normalizeLiveAnswer(question.expected))) return false;
    const actualValues = [...new Set(numberValues(value))];
    return Number.isFinite(expected) && actualValues.length === 1 && actualValues[0] === expected;
  }

  const candidates = [question.expected, ...question.aliases]
    .map(normalizeLiveAnswer)
    .filter((item) => item.length >= 3);
  const padded = ` ${normalized} `;
  return candidates.some((candidate) =>
    padded.includes(` ${candidate} `) && !candidateIsNegated(normalized, candidate),
  );
}

export function parseNumberedLiveAnswers(text: string): Map<number, string> {
  const answers = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s*[|.:：)\]-]\s*(.+)$/);
    if (!match) continue;
    const index = Number(match[1]);
    if (Number.isInteger(index) && index >= 1 && !answers.has(index)) {
      answers.set(index, match[2].trim());
    }
  }
  if (answers.size > 0) return answers;

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      parsed.forEach((item, index) => {
        if (typeof item === "string") answers.set(index + 1, item.trim());
      });
    } else if (parsed && typeof parsed === "object") {
      for (const [key, item] of Object.entries(parsed)) {
        const index = Number(key);
        if (Number.isInteger(index) && index >= 1 && typeof item === "string") {
          answers.set(index, item.trim());
        }
      }
    }
  } catch {
    // Keep malformed model output as an empty answer map.
  }
  return answers;
}

export function createLiveKnowledgePrompt(snapshot: LiveKnowledgeSnapshot): string {
  return [
    "这是实时知识快照检测。服务端不会把源数据答案放进提示；如果你的服务本身支持实时检索，可以使用自身能力获取答案。没有实时数据时请明确说明无法获取，不要编造，也不要解释过程。",
    `快照日期：${snapshot.sourceDate}。公开源：${snapshot.sourceUrl}。`,
    "标题类问题请使用源数据中的英文标题，不要翻译。",
    "只回答下面的问题，并严格按“序号|答案”逐行输出。不要添加其他文字。",
    ...snapshot.questions.map((question, index) => `${index + 1}|${question.prompt}`),
  ].join("\n");
}

export function gradeLiveKnowledge(snapshot: LiveKnowledgeSnapshot, responseText: string): LiveKnowledgeGrade {
  const answers = parseNumberedLiveAnswers(responseText);
  const results = snapshot.questions.map((question, index) => {
    const actual = answers.get(index + 1) ?? "";
    const abstained = isLiveKnowledgeAbstention(actual);
    const passed = !abstained && liveKnowledgeAnswerMatches(question, actual);
    const classification: "correct" | "wrong" | "abstained" = passed
      ? "correct"
      : abstained
        ? "abstained"
        : "wrong";
    return {
      id: question.id,
      expected: question.expected,
      actual,
      passed,
      classification,
    };
  });
  const correct = results.filter((result) => result.passed).length;
  const abstained = results.filter((result) => result.classification === "abstained").length;
  return {
    correct,
    abstained,
    total: results.length,
    score: results.length > 0 ? Math.round((correct / results.length) * 100) : 0,
    results,
  };
}

export function liveKnowledgeGradePasses(snapshot: LiveKnowledgeSnapshot, grade: LiveKnowledgeGrade): boolean {
  return grade.total === snapshot.questions.length && grade.correct >= snapshot.requiredCorrect;
}

export function isLiveKnowledgeSnapshot(value: unknown): value is LiveKnowledgeSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  const cache = snapshot.cache;
  return snapshot.schemaVersion === 2 &&
    typeof snapshot.snapshotId === "string" &&
    typeof snapshot.generatedAt === "string" &&
    typeof snapshot.sourceDate === "string" &&
    typeof snapshot.sourceName === "string" &&
    typeof snapshot.sourceUrl === "string" &&
    Number.isInteger(snapshot.requiredCorrect) &&
    Number(snapshot.requiredCorrect) >= 1 &&
    Boolean(cache) && typeof cache === "object" &&
    typeof (cache as Record<string, unknown>).status === "string" &&
    ["miss", "hit", "stale"].includes(String((cache as Record<string, unknown>).status)) &&
    typeof (cache as Record<string, unknown>).ageSeconds === "number" &&
    typeof (cache as Record<string, unknown>).ttlSeconds === "number" &&
    Array.isArray(snapshot.questions) &&
    snapshot.questions.length === 4 &&
    Number(snapshot.requiredCorrect) <= snapshot.questions.length &&
    snapshot.questions.every((question) => {
      if (!question || typeof question !== "object") return false;
      const item = question as Record<string, unknown>;
      return typeof item.id === "string" &&
        typeof item.prompt === "string" &&
        (item.kind === "text" || item.kind === "number") &&
        typeof item.expected === "string" &&
        Array.isArray(item.aliases) &&
        item.aliases.every((alias) => typeof alias === "string") &&
        typeof item.sourcePath === "string";
    });
}
