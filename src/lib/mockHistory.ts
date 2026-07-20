import type { CheckItem } from "@/components/DetectionChecklist";
import type { DetectionResultData } from "@/components/DetectionResultCard";
import type { HistoryEntry } from "@/components/HistoryLog";

function buildChecks(
  protocol: CheckItem["status"],
  structure: CheckItem["status"],
  cutoff: CheckItem["status"],
  identity: CheckItem["status"],
  thinking: CheckItem["status"],
  signature: CheckItem["status"],
): CheckItem[] {
  return [
    {
      name: "Protocol Signature",
      status: protocol,
      detail: protocol === "pass" ? "Stable" : protocol === "warning" ? "Partial" : "Weak",
      trace: JSON.stringify({ protocol }, null, 2),
    },
    {
      name: "Response Structure",
      status: structure,
      detail: structure === "pass" ? "JSON Valid" : structure === "warning" ? "Single Prompt" : "Invalid",
      trace: JSON.stringify({ structure }, null, 2),
    },
    {
      name: "Knowledge Cutoff",
      status: cutoff,
      detail: cutoff === "pass" ? "Pass" : "Fail",
    },
    {
      name: "Identity Match",
      status: identity,
      detail: identity === "pass" ? "Consistent" : "Mismatch",
    },
    {
      name: "Thinking Chain",
      status: thinking,
      detail: thinking === "pass" ? "Present" : thinking === "warning" ? "Sparse" : "Missing",
      trace: JSON.stringify({ thinking }, null, 2),
    },
    {
      name: "Signature Length",
      status: signature,
      detail: signature === "pass" ? "Sufficient" : signature === "warning" ? "Short" : "Missing",
      trace: JSON.stringify({ signature }, null, 2),
    },
  ];
}

function buildResult(
  id: string,
  score: number,
  latency: number,
  tps: number,
  inputTokens: number,
  outputTokens: number,
  checks: CheckItem[],
): DetectionResultData {
  return {
    id,
    score,
    checks,
    latency,
    tps,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

const mockResults: DetectionResultData[] = [
  buildResult("#842731", 91, 1280, 37.2, 1180, 312, buildChecks("pass", "pass", "pass", "pass", "pass", "pass")),
  buildResult("#842730", 76, 1610, 29.4, 1265, 403, buildChecks("pass", "pass", "fail", "pass", "warning", "pass")),
  buildResult("#842729", 63, 1940, 21.7, 1402, 512, buildChecks("warning", "pass", "fail", "pass", "warning", "warning")),
  buildResult("#842728", 44, 2360, 15.9, 1540, 689, buildChecks("fail", "warning", "fail", "fail", "warning", "fail")),
];

export const MOCK_HISTORY_ENTRIES: HistoryEntry[] = mockResults.map((result, index) => ({
  id: result.id,
  timestamp: `3/${20 - index}, ${String(18 - index).padStart(2, "0")}:${String(12 + index).padStart(2, "0")}:4${index}`,
  model: index % 2 === 0 ? "Sonnet 4.6" : "Opus 4.6",
  endpoint: index % 2 === 0 ? "https://relay.example.com/v1/messages" : "https://api.gateway.example/v1/chat/completions",
  apiKey: "",
  score: result.score,
  status: "unverifiable",
  evidenceLevel: "insufficient",
  verdictReason: "insufficient-evidence",
  verifierScope: "quality-only",
  result,
}));
