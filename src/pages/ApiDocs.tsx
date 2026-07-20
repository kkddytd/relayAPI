import { useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Info, Terminal } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { useI18n } from "@/i18n";

const installationReportBaseUrl = (
  import.meta.env.VITE_INSTALL_REPORT_BASE_URL || "http://YOUR_SERVER_IP"
).replace(/\/+$/, "");

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard?.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-foreground text-background">
      <div className="flex h-10 items-center justify-between border-b border-background/15 px-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-background/70">
          <Terminal className="h-3.5 w-3.5" />
          {label}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="grid h-7 w-7 place-items-center rounded-md text-background/70 transition-colors hover:bg-background/10 hover:text-background"
          title={copied ? "Copied" : "Copy"}
          aria-label={copied ? "Copied" : "Copy"}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto p-4 text-xs leading-6 sm:text-sm"><code>{code}</code></pre>
    </div>
  );
}

function DocTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[680px] border-collapse text-left text-sm">
        <thead className="bg-muted">
          <tr>
            {headers.map((header) => (
              <th key={header} className="border-b border-border px-3 py-2.5 font-semibold text-foreground">{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${row[0]}-${rowIndex}`} className="border-b border-border last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={`${cellIndex}-${cell}`} className={`px-3 py-2.5 align-top leading-relaxed ${cellIndex === 0 ? "font-mono text-xs text-foreground" : "text-muted-foreground"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ApiDocs() {
  const { lang } = useI18n();
  const zh = lang === "zh";
  const apiBaseUrl = "https://YOUR_SERVER_IP:8443";
  const curl = useMemo(() => `curl -k -X POST '${apiBaseUrl}/api/v1/detections' \\
  -H 'Authorization: Bearer YOUR_DETECTOR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  --data '{
    "base_url": "https://api.example.com",
    "upstream_api_key": "sk-test-only",
    "model": "claude-5-fable",
    "protocol": "auto",
    "question_mode": "official-random",
    "rounds": 1,
    "checks": {
      "cache": false,
      "cache_runs": 1,
      "live_knowledge": false
    }
  }'`, [apiBaseUrl]);
  const customProfileCurl = useMemo(() => `curl -k -X POST '${apiBaseUrl}/api/v1/detections' \\
  -H 'Authorization: Bearer YOUR_DETECTOR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  --data '{
    "base_url": "https://api.example.com",
    "upstream_api_key": "sk-test-only",
    "model": "vendor-fable-v9",
    "profile_model": "claude-fable-5",
    "protocol": "anthropic",
    "question_mode": "official-random"
  }'`, [apiBaseUrl]);
  const cacheCurl = useMemo(() => `curl -k -X POST '${apiBaseUrl}/api/v1/detections' \\
  -H 'Authorization: Bearer YOUR_DETECTOR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  --data '{
    "base_url": "https://api.example.com",
    "upstream_api_key": "sk-test-only",
    "model": "claude-opus-4-8",
    "protocol": "anthropic",
    "question_mode": "stable",
    "checks": { "cache": true, "cache_runs": 3, "live_knowledge": false }
  }'`, [apiBaseUrl]);
  const localCurl = useMemo(() => `curl -k -X POST '${apiBaseUrl}/api/v1/detections' \\
  -H 'Content-Type: application/json' \\
  --data '{"base_url":"https://api.example.com","upstream_api_key":"sk-test-only","model":"gpt-5.5"}'`, [apiBaseUrl]);
  const attachmentDetectionCurl = useMemo(() => `curl -k -X POST '${apiBaseUrl}/api/v1/detections' \\
  -H 'Authorization: Bearer YOUR_DETECTOR_API_KEY' \\
  -F 'request={"base_url":"https://api.example.com","upstream_api_key":"sk-test-only","model":"claude-opus-4-8","protocol":"anthropic"}' \\
  -F 'files=@./generated-003.png'`, [apiBaseUrl]);
  const installationCurl = `curl -X POST '${installationReportBaseUrl}/api/v1/installations/report'`;
  const responseExample = `{
  "ok": true,
  "api_version": "v1",
  "engine_version": "2026-07-17.3",
  "id": "6acb...",
  "status": "completed",
  "score": 100,
  "request": {
    "base_url": "https://api.example.com/",
    "model": "vendor-fable-v9",
    "profile_model": "claude-fable-5",
    "profile_resolution": "explicit",
    "protocol": "anthropic",
    "question_mode": "official-random",
    "rounds": 1,
    "checks": { "cache": false, "cache_runs": 1, "live_knowledge": false }
  },
  "profile": {
    "model": "claude-fable-5",
    "probe_family": "claude-fable",
    "dedicated": true,
    "resolution": "explicit",
    "request_fingerprint": "official-public"
  },
  "scores": {
    "primary": 100,
    "primary_basis": "official_compatibility",
    "quality": 100,
    "official_compatibility": 100,
    "behavior": 100,
    "public_observable": 100,
    "private_signature_adjustment": 0,
    "private_signature_status": "envelope_compatible",
    "signature_evidence_status": "envelope_compatible"
  },
  "scoring_reference": {
    "capturedAt": "2026-07-15",
    "bundle": "shareReport-B_FOiUEI.js",
    "bundleSha256": "02593b4301418722cbd19200822a87a05f041314504f07f0e37aebab415267e8",
    "probeConstantsBundle": "probe-constants-YXB5_aNC.js",
    "probeConstantsSha256": "ec057d221fa24d106fb64ccbc5914ae04fedb1b6f7f602fe15833768bbb41bcf"
  },
  "verdict": {
    "value": "consistent",
    "evidence_level": "behavioral",
    "source_verified": false
  },
  "channel": {
    "kind": "hidden-upstream",
    "transport_verified": false,
    "source_verified": false
  },
  "checks": [],
  "metrics": {},
  "cache": { "requested": false, "status": "not-requested" },
  "live_knowledge": { "requested": false, "status": "not-requested" },
  "rounds": [],
  "warnings": []
}`;

  const requestRows = zh
    ? [
        ["base_url", "string", "是", "目标 API 的基础地址或完整接口地址，支持自定义中转站地址。"],
        ["upstream_api_key", "string", "是", "目标接口的 API Key。仅用于本次上游请求，不会出现在响应中。"],
        ["api_key", "string", "兼容", "已弃用的 upstream_api_key 别名。新调用请使用 upstream_api_key；两者同时传入时以前者为准。"],
        ["model", "string", "是", "实际发送给上游的模型 ID，可使用内置名称或任意自定义模型名，例如 claude-5-fable。"],
        ["profile_model", "string", "否", "评测档案。省略时自动识别受控别名；未知中转名可显式指定 claude-fable-5 等内置档案。"],
        ["protocol", "enum", "否", "默认 auto。可选 anthropic、openai-chat、openai-responses、openai-images、google-generative。"],
        ["question_mode", "enum", "否", "默认 official-random，按官网每次随机抽题并记录题目 ID；stable 仅用于可重复的日批测试。"],
        ["rounds", "integer", "否", "稳定性检测轮数，1-3，默认 1。多轮会轮换知识题批，2 轮取平均、3 轮取中位数；费用按轮数增加。"],
        ["checks.cache", "boolean", "否", "默认 false。Anthropic 协议会执行一组或多组缓存观测，每组固定 5 个逻辑轮次；5xx 重试或协议档案回退可能增加实际请求数。Fable 可观测，但因无独立官网基线而不计算缓存兼容分。"],
        ["checks.cache_runs", "integer", "否", "独立缓存验证组数，1-3，默认 1，仅在 checks.cache=true 时生效。每组固定 5 个逻辑轮次并使用新的 cache marker；多组全部完成后取各组中位数。"],
        ["checks.live_knowledge", "boolean", "否", "默认 false。额外发送 1 个实时知识访问能力请求，不计入质量分。"],
        ["attachments", "array", "否", "multipart 请求中按 files 的顺序填写可选模式和指令，无需 ID。附件检查只判断模型是否返回了基于附件的证据，不判断内容准确性，也不改变主分。旧的 verify/expected_intent 仅为兼容保留。"],
      ]
    : [
        ["base_url", "string", "Yes", "Target API base URL or full endpoint; custom relay addresses are supported."],
        ["upstream_api_key", "string", "Yes", "Credential sent only to the target upstream. It is never returned in the report."],
        ["api_key", "string", "Compatibility", "Deprecated alias for upstream_api_key. New callers should use upstream_api_key; it wins when both are supplied."],
        ["model", "string", "Yes", "Exact model ID sent upstream; presets and arbitrary custom IDs are supported."],
        ["profile_model", "string", "No", "Evaluation profile. Known aliases resolve automatically; set a built-in profile explicitly for unknown relay names."],
        ["protocol", "enum", "No", "Defaults to auto. Supports anthropic, openai-chat, openai-responses, openai-images, and google-generative."],
        ["question_mode", "enum", "No", "Defaults to official-random, matching the public website's per-run selection and recording question IDs. Use stable only for reproducible daily batches."],
        ["rounds", "integer", "No", "Stability rounds from 1 to 3. Knowledge batches rotate; two rounds average and three rounds use the median. Cost grows proportionally."],
        ["checks.cache", "boolean", "No", "Defaults to false. Runs one or more Anthropic cache-observation groups, each with five logical rounds; 5xx retries or protocol-profile fallback may add requests. Fable can be observed but has no independent public baseline or cache compatibility score."],
        ["checks.cache_runs", "integer", "No", "Independent cache-validation groups from 1 to 3; defaults to 1 and applies only when checks.cache=true. Every group has five logical rounds and a fresh cache marker. Complete multi-group results use the median across groups."],
        ["checks.live_knowledge", "boolean", "No", "Defaults to false. Sends one independent live-access check, excluded from quality scoring."],
        ["attachments", "array", "No", "For multipart requests, list optional modes and instructions in files order. No IDs are required. The recognition check only asks whether the model returned attachment-grounded evidence; it does not judge semantic accuracy or alter the primary score. Legacy verify/expected_intent fields remain for compatibility."],
      ];

  const responseRows = zh
      ? [
        ["status", "completed / incomplete / unavailable", "完整、部分未完成或上游完全不可用。只有 completed 才会给完整分数。"],
        ["score", "number | null", "调用方应优先读取的唯一主分，等于 scores.primary。再结合 scores.primary_basis 判断其来源。"],
        ["scores.primary", "number | null", "score 的诊断副本。专用档案取公开公式兼容分；仅质量档案取能力分。"],
        ["scores.primary_basis", "official_compatibility / quality", "official_compatibility 表示专用档案的公开公式兼容分；quality 表示仅质量档案的确定性能力分。"],
        ["scores.quality", "number | null", "任务正确性与接口完整性分；不是模型真伪证明。"],
        ["scores.official_compatibility", "number | null", "仅专用档案返回，按公开公式及稳定性修正计算；不是密码学验真。独立签名探针已得到完整直连同模型信封时，能力题阶段偶发的 adaptive-thinking 签名不会触发 34 分硬上限。"],
        ["scores.official_result", "pass / fail / error | null", "按档案阈值返回：Claude 为 60 分，GPT/Gemini 为 70 分；与谨慎的来源真伪结论分开。仅质量档案返回 null。"],
        ["scores.behavior", "number | null", "行为与协议一致性分；不是密码学验真。"],
        ["scores.public_observable", "number | null", "专用档案中，本地公开可观测证据支持的分数；存在完整 Claude protobuf 签名信封时会包含其 PASS/PARTIAL 兼容分支。"],
        ["scores.private_signature_adjustment", "number | null", "完整信封和私有结论都不可用时的保守调整，通常为 0 或负数。负数表示证据覆盖缺口，不表示模型失败。"],
        ["scores.signature_evidence_status", "verified / envelope_compatible / unavailable / not_observed / mixed / not_applicable", "主分采用的签名证据状态。envelope_compatible 只证明 protobuf 信封结构兼容，不是 Anthropic 公钥验签。"],
        ["scores.private_signature_status", "same as signature_evidence_status", "兼容旧调用方的别名。"],
        ["scoring_reference", "object", "公开前端 bundle、抓取日期和 SHA-256 指纹。"],
        ["profile", "object", "实际采用的评测档案、探针家族、档案解析方式和 request_fingerprint。专用 Claude 使用 official-public 以匹配官网公开的 metadata、Claude Code system 和 Stainless 请求头指纹。"],
        ["verdict", "object", "结论、证据等级、来源是否验证及原因。隐藏上游即使满分也不会显示已验真。"],
        ["channel", "object", "请求主机、最终主机、HTTP 状态、提供商传输路径和隐藏渠道证据。possible-vertex-or-bedrock 表示发现签名信封 channel=1，仅为低置信结构提示。"],
        ["checks", "array", "聚合后的能力、行为与运行检查；包含每轮通过/失败数。"],
        ["metrics", "object", "总耗时、核心探针耗时、输入/输出 token 和请求数。"],
        ["cache", "object", "一至三组独立五轮缓存检测、归档参考基线、加权 Token、综合倍率和命中率；多组完整时顶层指标取中位数，不计入模型主分。"],
        ["live_knowledge", "object", "独立实时访问能力结果，不计入模型身份与质量分。source_snapshot_fetched 与模型联网是两件事。"],
        ["attachment_analysis", "object | null", "附件可识别性检查报告：recognition_status、recognition_total 和 recognized_count 判断模型是否收到并返回附件证据；不判断内容准确性。scored=false 且 affects_primary_score=false；附件失败也不会把主检测改为失败。"],
        ["rounds", "array", "每轮原始检查和指标，便于定位波动来源。"],
        ["warnings", "array", "成本、来源边界或检测不完整提醒。"],
      ]
      : [
        ["status", "completed / incomplete / unavailable", "Only completed reports contain a complete score."],
        ["score", "number | null", "The one canonical score callers should read first. It equals scores.primary; use scores.primary_basis to interpret it."],
        ["scores.primary", "number | null", "Diagnostic mirror of score: public compatibility for dedicated profiles, quality for quality-only profiles."],
        ["scores.primary_basis", "official_compatibility / quality", "Indicates whether the primary score comes from the dedicated public compatibility formula or deterministic quality diagnostics."],
        ["scores.quality", "number | null", "Task correctness and API integrity; not identity proof."],
        ["scores.official_compatibility", "number | null", "Public-formula score with a stability correction for dedicated profiles; not cryptographic verification. A complete direct same-model envelope prevents incidental adaptive-thinking signatures in capability stages from triggering the 34-point cap."],
        ["scores.official_result", "pass / fail / error | null", "Public-verifier result using 60 for Claude and 70 for GPT/Gemini, kept separate from the provenance verdict. Null for quality-only profiles."],
        ["scores.behavior", "number | null", "Behavior and protocol consistency; not cryptographic verification."],
        ["scores.public_observable", "number | null", "Dedicated-profile score supported by locally observable evidence, including the PASS/PARTIAL branch of a complete Claude protobuf signature envelope."],
        ["scores.private_signature_adjustment", "number | null", "Conservative adjustment when neither a complete envelope nor a private verdict is available. A negative value is an evidence gap, not model failure."],
        ["scores.signature_evidence_status", "verified / envelope_compatible / unavailable / not_observed / mixed / not_applicable", "Signature evidence used by the primary score. envelope_compatible is structural protobuf evidence, not Anthropic public-key verification."],
        ["scores.private_signature_status", "same as signature_evidence_status", "Backward-compatible alias."],
        ["scoring_reference", "object", "Public frontend bundle, capture date, and SHA-256 used by this engine version."],
        ["profile", "object", "Selected profile, probe family, resolution mode, and request_fingerprint. Dedicated Claude uses official-public to match the public metadata, Claude Code system, and Stainless header fingerprint."],
        ["verdict", "object", "Conclusion, evidence level, source-verification flag, and reason."],
        ["channel", "object", "Requested/final hosts, HTTP statuses, provider transport, and hidden-channel evidence. possible-vertex-or-bedrock is a low-confidence structural hint from signature channel=1."],
        ["checks", "array", "Aggregated capability, behavior, and operational checks with round counts."],
        ["metrics", "object", "Duration, token totals, and core probe count."],
        ["cache", "object", "One to three independent five-round cache groups, archived references, weighted tokens, multiplier, and hit rate. Complete multi-group top-level metrics use the median and remain excluded from the primary score."],
        ["live_knowledge", "object", "Independent live-access result, excluded from identity and quality scores. A fetched server snapshot is not proof of model network access."],
        ["attachment_analysis", "object | null", "Independent attachment-recognition report. recognition_status and per-item recognition_reason say whether the model returned grounded attachment evidence; semantic accuracy is not judged. scored and affects_primary_score are false; an attachment failure does not fail the primary detection."],
        ["rounds", "array", "Per-round checks and metrics for stability diagnosis."],
        ["warnings", "array", "Cost, provenance boundary, and incomplete-run notices."],
      ];

  const checkRows = zh
    ? [
        ["stage_identity", "behavior", "官网公开阶段指纹。对部分 Claude 档案，主能力阶段出现 signature_delta 会触发 34 分上限；它可能随 adaptive thinking 或上游路由变化，不等于 model 字段不匹配。"],
        ["model_identity", "behavior", "响应声明的模型家族是否与评测档案一致。自定义上游模型名仍以 profile_model 为预期家族。"],
        ["signature", "behavior", "Claude protobuf 签名信封、模型字段与 channel 标记。evidence.structural_compatibility_verdict 会返回 PASS/PARTIAL/UNKNOWN；cryptographically_verified=false 时仍只是结构兼容证据。"],
        ["upstream_unavailable", "operational", "没有产生可用上游响应。此时 status=unavailable、所有分数为 null，不能按模型失败解释。"],
        ["request_compatibility", "operational", "上游拒绝公开模板中的兼容字段后使用了受控重试，例如移除明确报错的 anthropic-beta。"],
        ["knowledge / pdf / calculation", "capability", "近期知识、PDF 动态文本和结构化计算的任务正确性。题目通过不证明模型来源。"],
      ]
    : [
        ["stage_identity", "behavior", "Public stage fingerprint. For some Claude profiles, signature_delta in a main capability stage triggers the 34-point cap. Adaptive thinking or routing can change this signal; it is not a model-field mismatch."],
        ["model_identity", "behavior", "Whether the reported model family matches the evaluation profile. profile_model defines the expected family for custom upstream IDs."],
        ["signature", "behavior", "Claude protobuf signature envelope, model metadata, and channel marker. evidence.structural_compatibility_verdict returns PASS/PARTIAL/UNKNOWN; it remains structural evidence while cryptographically_verified=false."],
        ["upstream_unavailable", "operational", "No usable upstream response was produced. status is unavailable and all scores are null."],
        ["request_compatibility", "operational", "A controlled retry removed a field explicitly rejected by the upstream, such as an invalid anthropic-beta header."],
        ["knowledge / pdf / calculation", "capability", "Task correctness for recent knowledge, dynamic PDF text, and structured calculation. Passing does not prove provenance."],
      ];

  const cacheRows = zh
    ? [
        ["cache.requested_runs / completed_runs", "integer 0-3", "请求的独立五轮验证组数与完整完成的组数。只有 completed_runs 等于 requested_runs 时才生成多组聚合指标。"],
        ["cache.aggregation", "single / median", "单组为 single；请求 2-3 组时为 median，顶层兼容分、命中率、倍率和 Token 指标取各完整组中位数。"],
        ["cache.status", "enum", "confirmed 表示五轮完成且 4/4 预热轮次都有缓存读取；unconfirmed 表示有 usage 证据但预热轮次覆盖不完整或读取不稳定；unobserved 表示五轮完成但四个预热轮次没有缓存 usage 字段，不能解读为真实未命中；incomplete/failed 表示请求未完整。"],
        ["cache.completed_rounds / logical_rounds", "integer", "已完成逻辑轮次与计划逻辑轮次；正常完成为 5/5。多组时与 cache.rounds[] 一样表示代表组，而不是合成的 10/15 轮。"],
        ["cache.request_attempts", "integer", "全部验证组实际发送给上游的请求总数，包含同轮 5xx 重试和请求档案回退，因此可能大于 5 x requested_runs。"],
        ["cache.request_profiles_used", "string[]", "按顺序列出 custom / claude_code 请求档案；发生回退时同时返回两者。"],
        ["cache.observed_warm_rounds", "integer 0-4", "四个预热轮次中实际返回缓存 usage 字段的数量。只有 4/4 且每轮都有读取 token 才能显示 confirmed；多组时该值对应代表组，请以 cache.runs[] 比较波动。"],
        ["cache.compatibility_score", "0-100 | null", "仅 Opus 4.6/4.7/4.8 和 Sonnet 4.6 按同模型、同公开 custom 模板基线计算；多组时为各完整组中位数。Fable 始终返回 null。该字段不是模型质量分或真伪分。"],
        ["cache.reference_weighted_tokens", "number | null", "五轮公开基线按输入 1.0、输出 5.0、缓存创建 1.25、缓存读取 0.1 加权后的总量。"],
        ["cache.measured_weighted_tokens", "number | null", "单组为该组五轮加权总量；多组为每组总量的中位数，不是合成的 10/15 轮总量。"],
        ["cache.overall_multiplier", "number | null", "实测加权 Token / 参考加权 Token。"],
        ["cache.average_hit_rate", "number | null", "第 2-5 轮 cache_read / (input + cache_write + cache_read) 的算术平均。"],
        ["cache.baseline", "object", "参考模型、基线来源、参考加权量和参考命中率。Fable 的 Opus 4.8 映射仅描述请求规模，不是 Fable 独立基线。"],
        ["cache.comparison_assumption", "string | null", "仅 canonical 基线比较在缺少 usage 字段时返回 missing_usage_treated_as_zero：公开兼容公式按 0 读取计算，但实际观测仍是 unobserved，不代表真实未命中。"],
        ["cache.runs[]", "array", "每个独立验证组的完整五轮报告，按执行顺序返回；子项的 run 为 1-3，且不会再嵌套 runs。多组调用应以此字段查看各组波动。"],
        ["cache.runs[].run", "integer 1-3", "独立验证组的从 1 开始序号。"],
        ["cache.rounds[]", "array", "向后兼容的单个真实代表组明细；多组时不能把它解释为全部 10/15 轮。每轮包含输入、输出、缓存创建/读取、加权量、倍率和判定。"],
        ["cache.failure_detail", "string | null", "缓存请求失败或响应无效时的简化原因。"],
      ]
    : [
        ["cache.requested_runs / completed_runs", "integer 0-3", "Requested independent five-round groups and groups that completed all five rounds. Multi-group aggregate metrics are emitted only when these values match."],
        ["cache.aggregation", "single / median", "single is used for one group. Two or three requested groups use median for top-level compatibility, hit-rate, multiplier, and token metrics."],
        ["cache.status", "enum", "confirmed means five completed rounds with reads in all 4/4 warm rounds; unconfirmed means usage evidence exists but warm-round coverage or reads are incomplete; unobserved means all five completed but the four warm rounds exposed no cache-usage fields and must not be read as a real miss; incomplete/failed means the run did not finish."],
        ["cache.completed_rounds / logical_rounds", "integer", "Completed and planned logical rounds; a normal completed run reports 5/5. For multiple groups these describe the representative cache.rounds[] sequence, not a synthetic 10/15-round run."],
        ["cache.request_attempts", "integer", "Actual upstream attempts across all groups, including same-round 5xx retries and request-profile fallback, so this can exceed 5 x requested_runs."],
        ["cache.request_profiles_used", "string[]", "Ordered custom / claude_code request profiles. Both are returned when fallback occurs."],
        ["cache.observed_warm_rounds", "integer 0-4", "Number of the four warm rounds that returned provider cache-usage fields. Confirmation requires 4/4 with positive reads. For multiple groups this describes the representative sequence; inspect cache.runs[] for variation."],
        ["cache.compatibility_score", "0-100 | null", "Calculated only for Opus 4.6/4.7/4.8 and Sonnet 4.6 against a same-model public custom baseline; multi-group results use the median. Always null for Fable; not a quality or identity score."],
        ["cache.reference_weighted_tokens", "number | null", "Five-round reference total weighted as input 1.0, output 5.0, cache write 1.25, and cache read 0.1."],
        ["cache.measured_weighted_tokens", "number | null", "One group's five-round weighted total, or the per-group median for multiple groups. It is not a synthetic 10/15-round sum."],
        ["cache.overall_multiplier", "number | null", "Measured weighted tokens divided by reference weighted tokens."],
        ["cache.average_hit_rate", "number | null", "Arithmetic mean for rounds 2-5 of cache_read / (input + cache_write + cache_read)."],
        ["cache.baseline", "object", "Reference model, source, weighted total, and warm hit rate. Fable's Opus 4.8 mapping describes request scale only; it is not an independent Fable baseline."],
        ["cache.comparison_assumption", "string | null", "For canonical comparisons only, missing_usage_treated_as_zero means the public compatibility formula used zero reads while the observation remains unobserved; it does not prove a real cache miss."],
        ["cache.runs[]", "array", "Full five-round report for every independent group in execution order. Child items have run=1..3 and do not nest runs. Use this field to inspect multi-group variation."],
        ["cache.runs[].run", "integer 1-3", "One-based index of the independent validation group."],
        ["cache.rounds[]", "array", "Backward-compatible details for one real representative group. With multiple groups this is not all 10/15 rounds. Each item contains token usage, multiplier, deltas, and assessment."],
        ["cache.failure_detail", "string | null", "Sanitized failure reason when the cache run cannot complete."],
      ];

  const liveKnowledgeRows = zh
    ? [
        ["live_knowledge.status", "enum", "passed / failed / no-live-access / unavailable / skipped / not-requested。skipped 表示核心探针不可用，本次未继续消耗额度运行实时知识请求。"],
        ["live_knowledge.reason", "string | undefined", "跳过时的机器可读原因，例如 core_unavailable。"],
        ["live_knowledge.source_snapshot_fetched", "boolean", "true 表示 kk 服务端已获得并验证公开源快照；快照可能来自本次拉取或本地缓存，不表示模型已联网。"],
        ["live_knowledge.source_cache_status", "miss | hit | stale | null", "miss 表示本次拉取，hit 表示使用未过期本地快照，stale 表示公开源失败后使用同日降级快照。"],
        ["live_knowledge.source_cache_age_seconds", "number | null", "源快照年龄（秒）。"],
        ["live_knowledge.source_cache_ttl_seconds", "number | null", "源快照正常 TTL（秒）。"],
        ["live_knowledge.source_answers_sent_to_model", "boolean", "始终为 false。服务端只发送问题和源元数据，不会把快照标准答案发给模型。"],
        ["live_knowledge.results[]", "array", "每题的 expected、actual、passed 和 classification；该结果不计入质量分或模型身份结论。"],
      ]
    : [
        ["live_knowledge.status", "enum", "passed / failed / no-live-access / unavailable / skipped / not-requested. skipped means the core probes were unavailable, so no additional live-knowledge request was sent."],
        ["live_knowledge.reason", "string | undefined", "Machine-readable skip reason, such as core_unavailable."],
        ["live_knowledge.source_snapshot_fetched", "boolean", "True means the kk server obtained and validated a public source snapshot, either from this request or local cache; it does not mean the model had network access."],
        ["live_knowledge.source_cache_status", "miss | hit | stale | null", "miss means fetched for this request, hit means a fresh local snapshot, and stale means a same-day fallback after a source failure."],
        ["live_knowledge.source_cache_age_seconds", "number | null", "Age of the source snapshot in seconds."],
        ["live_knowledge.source_cache_ttl_seconds", "number | null", "Normal source-snapshot TTL in seconds."],
        ["live_knowledge.source_answers_sent_to_model", "boolean", "Always false. The server sends questions and source metadata, never the snapshot's expected answers."],
        ["live_knowledge.results[]", "array", "Per-question expected, actual, passed, and classification fields. Excluded from quality and identity conclusions."],
      ];

  const errorRows = [
    ["400 validation_failed", zh ? "参数缺失、字段类型错误、未知字段、URL/协议无效，或 rounds / checks.cache_runs 超出 1-3。详见 error.details。" : "Missing, mistyped, or unknown fields, invalid URL/protocol, or rounds/cache_runs outside 1-3. See error.details."],
    ["401 invalid_detector_api_key", zh ? "检测 API Key 缺失或错误。" : "Detector API key is missing or invalid."],
    ["413 request_body_too_large", zh ? "检测 JSON 元数据超过 MAX_REQUEST_BODY_BYTES；该限制不适用于流式附件上传。" : "Detection JSON metadata exceeds MAX_REQUEST_BODY_BYTES; this limit does not apply to streamed attachment uploads."],
    ["415 unsupported_media_type", zh ? "Content-Type 必须为 application/json 或 multipart/form-data。" : "Content-Type must be application/json or multipart/form-data."],
    ["429 detection_concurrency_limited", zh ? "并发检测已达到服务端上限，按 Retry-After 重试。" : "Concurrency limit reached; retry using Retry-After."],
    ["503 detector_api_not_configured", zh ? "服务对外开放但尚未配置检测 API Key。" : "Public API access is disabled until detector keys are configured."],
    ["500 detection_failed", zh ? "检测引擎内部失败；不会返回或记录明文上游 Key。" : "Internal detector failure; the upstream key is not returned or logged in plaintext."],
  ];

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-3 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="mb-8 border-b border-border pb-6">
          <p className="mb-2 font-mono text-xs font-medium text-primary">REST API v1</p>
          <h1 className="text-2xl font-bold text-foreground sm:text-3xl">{zh ? "接口说明" : "API Reference"}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">
            {zh
              ? "通过同步接口运行与网页端同类的模型质量、行为一致性、渠道证据、可选缓存和实时知识检查。检测 API Key 与上游 API Key 完全分开。"
              : "Run synchronous quality, behavior, channel, optional cache, and live-knowledge checks. Detector authentication is separate from the upstream credential."}
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <code className="rounded-md bg-muted px-2.5 py-1.5 text-foreground">POST /api/v1/detections</code>
            <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 font-medium text-primary hover:bg-muted">
              OpenAPI 3.1 <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>

        <div className="space-y-10">
          <section id="authentication">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "鉴权与密钥" : "Authentication"}</h2>
            <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-primary/25 bg-primary/5 p-3.5 text-sm leading-6 text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p>{zh ? "生产 API 可使用 Authorization: Bearer <检测 API Key>；受控反向代理部署也会自动签发无密码匿名 HttpOnly 会话，用于隔离网页历史和附件。upstream_api_key 只属于目标模型接口。" : "Production API calls may use a detector bearer key. A controlled reverse-proxy deployment can also issue a passwordless signed HttpOnly session that isolates Web history and attachments. upstream_api_key belongs only to the target model endpoint."}</p>
            </div>
            <CodeBlock code={curl} label={zh ? "生产调用" : "Production request"} />
            <div className="mt-3"><CodeBlock code={localCurl} label={zh ? "本机模式（未配置检测 API Key）" : "Local mode (no detector key configured)"} /></div>
          </section>

          <section id="request">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "请求参数" : "Request fields"}</h2>
            <p className="mb-4 mt-2 text-sm leading-7 text-muted-foreground">{zh ? "无附件时使用 application/json；有附件时使用 multipart/form-data，将检测 JSON 放入 request，文件放入 files。cache 与 live_knowledge 默认关闭。" : "Use application/json without attachments. With attachments, use multipart/form-data with the detection JSON in request and files in files. Cache and live-knowledge checks default off."}</p>
            <DocTable headers={zh ? ["字段", "类型", "必填", "说明"] : ["Field", "Type", "Required", "Description"]} rows={requestRows} />
          </section>

          <section id="attachments">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "附件检测" : "Attachment testing"}</h2>
            <div className="mt-2 space-y-3 text-sm leading-7 text-muted-foreground">
              <p>{zh
                ? "上传附件并检测时，直接调用 POST /api/v1/detections。检测 JSON 放入 request，附件使用 files；需要多个附件时重复传 files。"
                : "To upload attachments with a detection, call POST /api/v1/detections directly. Put the detection JSON in request and send attachments as files; repeat files for multiple attachments."}</p>
            </div>
            <div className="mt-4 space-y-4">
              <CodeBlock code={attachmentDetectionCurl} label={zh ? "上传附件并检测" : "Upload and detect"} />
            </div>
          </section>

          <section id="cache-api">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "缓存检测字段" : "Cache report fields"}</h2>
            <p className="mb-4 mt-2 text-sm leading-7 text-muted-foreground">{zh ? "每个独立缓存验证组固定执行 5 个逻辑轮次。checks.cache_runs 可请求 1-3 组；每组使用新的 cache marker，多组全部完成后顶层指标取各组中位数。任一组未完成时不生成聚合分，应查看 cache.runs[] 的组级明细。5xx 重试或请求档案回退会增加实际请求数。Fable 会展示真实缓存创建/读取 token 和命中率，但因无独立官网基线而不生成兼容分。缓存结果不会降低 scores.quality。" : "Every independent cache-validation group runs five logical rounds. checks.cache_runs requests one to three groups with fresh cache markers; top-level metrics use the median only after every group completes. If any group is incomplete, aggregate scores are suppressed and cache.runs[] retains the group-level reports. Transient retries or request-profile fallback can increase attempts. Fable reports real cache writes, reads, and hit rate but no compatibility score because it has no independent public baseline. Cache results do not lower scores.quality."}</p>
            <DocTable headers={zh ? ["字段", "类型/取值", "说明"] : ["Field", "Type / values", "Description"]} rows={cacheRows} />
            <div className="mt-4"><CodeBlock code={cacheCurl} label={zh ? "启用缓存检测" : "Enable cache probing"} /></div>
          </section>

          <section id="live-knowledge-api">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "实时知识字段" : "Live-knowledge fields"}</h2>
            <p className="mb-4 mt-2 text-sm leading-7 text-muted-foreground">{zh ? "kk 服务端负责拉取当前公开快照，模型必须使用自身实时访问能力回答。快照标准答案从不发送给模型。" : "The kk server fetches the current public snapshot, while the model must answer using its own live-access capability. Snapshot answers are never sent to the model."}</p>
            <DocTable headers={zh ? ["字段", "类型/取值", "说明"] : ["Field", "Type / values", "Description"]} rows={liveKnowledgeRows} />
          </section>

          <section id="profiles">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "自定义模型与评测档案" : "Custom models and profiles"}</h2>
            <div className="mt-3 space-y-3 text-sm leading-7 text-muted-foreground">
              <p>{zh
                ? "model 始终是原样发送给上游的模型 ID；profile_model 只决定使用哪套题目和行为探针。claude-5-fable、fable5 等受控别名会自动映射到 claude-fable-5，可以省略 profile_model。"
                : "model is always sent upstream unchanged. profile_model only selects the question set and behavior probes. Recognized aliases such as claude-5-fable and fable5 automatically map to claude-fable-5."}</p>
              <p>{zh
                ? "任意中转模型名无法可靠猜测其家族，例如 vendor-fable-v9；此时请显式传 profile_model。响应中的 request.profile_resolution 会显示 exact、auto-alias、explicit 或 quality-only。"
                : "Arbitrary relay names cannot be safely guessed. For a name such as vendor-fable-v9, pass profile_model explicitly. request.profile_resolution reports exact, auto-alias, explicit, or quality-only."}</p>
              <p>{zh
                ? "当前公开专用 GPT 范围是 gpt-5.6-sol、gpt-5.6-terra、gpt-5.5 和 gpt-5.4。只有这些档案使用官网近期知识探针；普通 gpt-5.6、Luna、GPT-4.1/4o 及其他 GPT 名称使用不依赖训练截止日期的确定性能力题，official_compatibility 返回 null。"
                : "The current public dedicated GPT set is gpt-5.6-sol, gpt-5.6-terra, gpt-5.5, and gpt-5.4. Only those profiles use the public recent-knowledge probe. Plain gpt-5.6, Luna, GPT-4.1/4o, and other GPT IDs use deterministic cutoff-independent quality tasks, and official_compatibility is null."}</p>
            </div>
            <div className="mt-4"><CodeBlock code={customProfileCurl} label={zh ? "未知中转模型名显式选择 Fable 档案" : "Explicit Fable profile for an unknown relay model"} /></div>
          </section>

          <section id="response">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "响应字段" : "Response fields"}</h2>
            <p className="mb-4 mt-2 text-sm leading-7 text-muted-foreground">{zh ? "HTTP 200 表示检测流程已返回报告，不代表上游一定可用。请先看 status，再看 scores 与 verdict。" : "HTTP 200 means a report was produced, not that the upstream succeeded. Read status before scores and verdict."}</p>
            <DocTable headers={zh ? ["字段", "类型/取值", "说明"] : ["Field", "Type / values", "Description"]} rows={responseRows} />
            <div className="mt-4"><CodeBlock code={responseExample} label={zh ? "响应示例" : "Response example"} /></div>
          </section>

          <section id="check-ids">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "检查项 ID" : "Check IDs"}</h2>
            <p className="mb-4 mt-2 text-sm leading-7 text-muted-foreground">{zh ? "先看 category 和 status，再结合 evidence 与 rounds。行为项与能力项不能互相替代。建议对会波动的专用 Claude 档案使用 rounds: 3。" : "Read category and status first, then evidence and rounds. Behavior checks do not replace capability checks. Use rounds: 3 for dedicated Claude profiles that show run-to-run variance."}</p>
            <DocTable headers={zh ? ["ID", "分类", "说明"] : ["ID", "Category", "Description"]} rows={checkRows} />
          </section>

          <section id="verdicts">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "状态与结论" : "Statuses and verdicts"}</h2>
            <DocTable
              headers={zh ? ["值", "含义"] : ["Value", "Meaning"]}
              rows={[
                ["completed", zh ? "核心探针完整完成，可以比较质量与行为分。" : "Core suite completed; quality and behavior scores are comparable."],
                ["incomplete", zh ? "部分探针被拒绝或响应无效；缺失项不按模型失败计分。" : "Some probes were rejected or malformed; missing checks are not scored as model failures."],
                ["unavailable", zh ? "没有可用上游响应，不计算分数。" : "No usable upstream response; scores are null."],
                ["consistent", zh ? "行为一致或官方传输路径成立，但不是具体模型的密码学证明。" : "Behavior or provider transport is consistent, but the specific model is not cryptographically proven."],
                ["suspicious", zh ? "发现明确 model 字段或签名格式冲突。" : "An explicit model-field or signature-format conflict was observed."],
                ["unverifiable", zh ? "可以测质量，但证据不足以判断隐藏上游真伪。" : "Quality is measurable, but hidden provenance cannot be verified."],
              ]}
            />
          </section>

          <section id="endpoints">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "其他接口" : "Other endpoints"}</h2>
            <DocTable
              headers={zh ? ["方法与路径", "鉴权", "说明"] : ["Method and path", "Auth", "Description"]}
              rows={[
                ["GET /api/v1", zh ? "无" : "None", zh ? "接口入口与当前鉴权模式。" : "API index and current authentication mode."],
                ["GET /api/v1/health", zh ? "无" : "None", zh ? "轻量健康检查，返回引擎版本、运行时间和当前检测并发数。" : "Lightweight health check with engine version, uptime, and active detection count."],
                ["GET /api/v1/models", zh ? "无" : "None", zh ? "内置模型目录、受控别名、专用探针覆盖范围和协议列表；仍支持自定义模型 ID。" : "Preset catalog, recognized aliases, dedicated coverage, and protocols; custom IDs remain supported."],
                ["GET /upload/{filename}", zh ? "无" : "None", zh ? "浏览器查看上传文件。上传响应和附件报告的 url 字段直接返回该路径；同名文件指向最新上传版本。" : "Open an uploaded file in a browser. The url field from upload and attachment reports uses this path; same-name files point to the latest upload."],
                ["POST /api/v1/installations/report", zh ? "无" : "None", zh ? "客户端安装完成后发送空 POST；成功返回 204，每次调用记为一次安装上报。" : "Send an empty POST after client installation. Returns 204 and counts one installation report per call."],
                ["GET /api/v1/installations/stats", zh ? "无" : "None", zh ? "返回累计上报数、今日上报数和最后上报时间。" : "Return total reports, today's reports, and the latest report time."],
                ["GET /api/v1/installations/stream", zh ? "无" : "None", zh ? "SSE 实时安装统计流，事件名为 stats。" : "Live installation-count SSE stream using stats events."],
                ["GET /api/v1/openapi.json", zh ? "无" : "None", zh ? "OpenAPI 3.1 文档。" : "OpenAPI 3.1 document."],
              ]}
            />
            <div className="mt-4"><CodeBlock code={installationCurl} label={zh ? "客户端安装完成上报" : "Report a completed client installation"} /></div>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">{zh
              ? "空上报不携带设备标识，因此统计值表示安装上报次数，而不是去重后的唯一设备数。若未来需要设备去重，必须单独定义匿名设备 ID 与隐私策略。"
              : "The empty report carries no device identifier, so the count represents installation reports rather than deduplicated unique devices. Device deduplication would require a separately defined anonymous device ID and privacy policy."}</p>
          </section>

          <section id="errors">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "错误码" : "Errors"}</h2>
            <DocTable headers={zh ? ["HTTP / code", "处理方式"] : ["HTTP / code", "Action"]} rows={errorRows} />
          </section>

          <section id="deployment" className="border-t border-border pt-8">
            <h2 className="text-xl font-semibold text-foreground">{zh ? "服务端配置" : "Server configuration"}</h2>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">{zh ? "对外提供接口时至少配置 DETECTOR_API_KEYS。多个 Key 使用英文逗号分隔；DETECTION_MAX_CONCURRENCY 默认 2，rounds、cache 和 live_knowledge 会显著影响实际并发占用与上游费用。" : "Set DETECTOR_API_KEYS before public exposure. Separate multiple keys with commas. DETECTION_MAX_CONCURRENCY defaults to 2; rounds, cache, and live_knowledge materially affect occupancy and upstream cost."}</p>
            <CodeBlock code={`HOST=127.0.0.1\nPORT=6722\nDETECTOR_API_KEYS=det_live_xxx,det_backup_xxx\nDETECTION_MAX_CONCURRENCY=2\nDETECTION_SEED_SECRET=replace-with-a-long-random-secret\nDATA_DIR=./data\nHISTORY_ENCRYPTION_KEY=replace-with-32-random-bytes\nWEB_SESSION_SECRET=replace-with-32-random-bytes\nATTACHMENT_ORPHAN_RETENTION_HOURS=24\nINSTALL_TRACKER_URL=http://127.0.0.1:6723\nINSTALL_TRACKER_HOST=127.0.0.1\nINSTALL_TRACKER_PORT=6723\nINSTALL_TRACKER_DATA_DIR=./data/install-tracker\nALLOW_LAN_WEB_WITHOUT_TURNSTILE=false\nLOG_RETENTION_DAYS=7`} label=".env" />
          </section>
        </div>
      </main>
    </div>
  );
}
