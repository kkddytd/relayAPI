import { motion } from "framer-motion";
import { CheckCircle2, XCircle, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Fragment, useState } from "react";
import { useI18n } from "@/i18n";

export interface CheckItem {
  name: string;
  status: "pass" | "fail" | "warning";
  detail: string;
  trace?: string;
  category?: "ability" | "authenticity" | "operational";
}

interface DetectionChecklistProps {
  items: CheckItem[];
  latency?: number;
  tps?: number;
  inputTokens?: number;
  outputTokens?: number;
}

const statusConfig = {
  pass: { icon: CheckCircle2, className: "text-success" },
  fail: { icon: XCircle, className: "text-error" },
  warning: { icon: AlertTriangle, className: "text-warning" },
};

export function DetectionChecklist({ items, latency, tps, inputTokens, outputTokens }: DetectionChecklistProps) {
  const { t } = useI18n();
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const categoryLabel = (category: CheckItem["category"]) => {
    if (category === "ability") return t("checkCategoryAbility");
    if (category === "authenticity") return t("checkCategoryAuthenticity");
    if (category === "operational") return t("checkCategoryOperational");
    return "";
  };

  return (
    <div className="space-y-0">
      {items.map((item, i) => {
        const config = statusConfig[item.status];
        const Icon = config.icon;
        const isExpanded = expandedIndex === i;
        const showCategory = Boolean(item.category) && item.category !== items[i - 1]?.category;

        return (
          <Fragment key={`${item.category ?? "uncategorized"}-${item.name}-${i}`}>
            {showCategory && (
              <div className={`${i === 0 ? "pt-1" : "pt-5"} pb-1 text-[11px] font-mono font-medium uppercase text-muted-foreground`}>
                {categoryLabel(item.category)}
              </div>
            )}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08, duration: 0.3, ease: [0.2, 0, 0, 1] }}
              className="border-b border-border last:border-b-0"
            >
              <button
                onClick={() => setExpandedIndex(isExpanded ? null : i)}
                className="w-full flex items-center justify-between gap-3 py-3.5 px-1 text-left hover:bg-muted/50 transition-colors"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Icon className={`w-4 h-4 shrink-0 ${config.className}`} />
                  <span className="text-sm font-medium text-foreground">{item.name}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`max-w-[13rem] text-right text-xs font-medium px-2 py-0.5 rounded-full whitespace-normal ${
                    item.status === "pass" ? "bg-success/10 text-success" :
                    item.status === "fail" ? "bg-error/10 text-error" :
                    "bg-warning/10 text-warning"
                  }`}>
                    {item.detail}
                  </span>
                  {item.trace && (
                    isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                </div>
              </button>
              {isExpanded && item.trace && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="px-1 pb-3"
                >
                  <pre className="text-xs font-mono bg-foreground/[0.03] border border-border rounded-lg p-3 overflow-x-auto text-muted-foreground whitespace-pre-wrap">
                    {item.trace}
                  </pre>
                </motion.div>
              )}
            </motion.div>
          </Fragment>
        );
      })}

      {/* Performance metrics */}
      {(latency || tps || inputTokens !== undefined || outputTokens !== undefined) && (
        <div className="flex gap-6 pt-4 mt-2 border-t border-border">
          {latency && (
            <div>
              <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{t("metricLatency")}</div>
              <div className="text-lg font-semibold text-foreground tabular-nums">{latency}ms</div>
            </div>
          )}
          {tps && (
            <div>
              <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{t("metricTokensPerSecond")}</div>
              <div className="text-lg font-semibold text-foreground tabular-nums">{tps}</div>
            </div>
          )}
          {inputTokens !== undefined && (
            <div>
              <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{t("metricInputTokens")}</div>
              <div className="text-lg font-semibold text-foreground tabular-nums">{inputTokens}</div>
            </div>
          )}
          {outputTokens !== undefined && (
            <div>
              <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{t("metricOutputTokens")}</div>
              <div className="text-lg font-semibold text-foreground tabular-nums">{outputTokens}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
