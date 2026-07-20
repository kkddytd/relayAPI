import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";

interface ScoreGaugeProps {
  score: number | null; // 0-100, or null when the upstream produced no usable evidence
  label?: string;
}

export function ScoreGauge({ score, label }: ScoreGaugeProps) {
  const { t } = useI18n();
  const [animatedScore, setAnimatedScore] = useState(0);
  const radius = 80;
  const strokeWidth = 12;
  const circumference = 2 * Math.PI * radius;
  const progress = score === null ? 0 : (animatedScore / 100) * circumference;

  useEffect(() => {
    const timer = setTimeout(() => setAnimatedScore(score ?? 0), 100);
    return () => clearTimeout(timer);
  }, [score]);

  const getColor = () => {
    if (score === null) return "hsl(var(--muted-foreground))";
    if (score >= 80) return "hsl(var(--primary))";
    if (score >= 50) return "hsl(var(--warning))";
    return "hsl(var(--error))";
  };

  const getLabel = () => {
    if (label) return label;
    return t("resultQualityGauge");
  };

  return (
    <div className="flex flex-col items-center justify-center py-4">
      <svg width="200" height="200" viewBox="0 0 200 200">
        {/* Background circle */}
        <circle
          cx="100"
          cy="100"
          r={radius}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth={strokeWidth}
        />
        {/* Progress circle */}
        <motion.circle
          cx="100"
          cy="100"
          r={radius}
          fill="none"
          stroke={getColor()}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference - progress }}
          transition={{ duration: 1.5, ease: [0.2, 0, 0, 1] }}
          transform="rotate(-90 100 100)"
        />
        {/* Score text */}
        <text
          x="100"
          y="92"
          textAnchor="middle"
          className="fill-foreground"
          style={{ fontSize: "42px", fontWeight: 700, fontFamily: "'IBM Plex Sans'", fontVariantNumeric: "tabular-nums" }}
        >
          {score === null ? "—" : `${animatedScore}%`}
        </text>
        <text
          x="100"
          y="118"
          textAnchor="middle"
          className="fill-muted-foreground"
          style={{ fontSize: "13px", fontWeight: 500 }}
        >
          {getLabel()}
        </text>
      </svg>
    </div>
  );
}
