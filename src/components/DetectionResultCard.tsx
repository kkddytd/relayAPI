import { Zap } from "lucide-react";
import { ScoreGauge } from "@/components/ScoreGauge";
import { DetectionChecklist, type CheckItem } from "@/components/DetectionChecklist";
import { useI18n } from "@/i18n";

export interface DetectionResultData {
  id: string;
  score: number | null;
  checks: CheckItem[];
  latency: number;
  tps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface DetectionResultCardProps {
  result: DetectionResultData;
  className?: string;
}

export function DetectionResultCard({ result, className = "" }: DetectionResultCardProps) {
  const { t } = useI18n();

  return (
    <div className={`rounded-xl border border-border bg-card p-4 sm:p-6 ${className}`.trim()}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          <h3 className="text-lg font-semibold tracking-tight text-foreground">
            {t("resultTitle")}
          </h3>
        </div>
        <span className="text-xs font-mono text-muted-foreground">
          {t("reportIdPrefix")}: {result.id}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4 sm:gap-6">
        <ScoreGauge score={result.score} />
        <DetectionChecklist
          items={result.checks}
          latency={result.latency}
          tps={result.tps}
          inputTokens={result.inputTokens}
          outputTokens={result.outputTokens}
        />
      </div>
    </div>
  );
}
