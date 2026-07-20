import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { useI18n } from "@/i18n";
import { MODELS } from "@/lib/models";
import { hasDedicatedVerifier } from "@/lib/authenticity";

interface ModelSelectorProps {
  selected: string | null;
  onSelect: (id: string) => void;
}

export function ModelSelector({ selected, onSelect }: ModelSelectorProps) {
  const { t } = useI18n();

  return (
    <div className="mt-5">
      <div id="model-target-label" className="block text-xs font-medium text-muted-foreground mb-2.5 uppercase tracking-wider font-mono">
        {t("modelTargetLabel")}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3" role="group" aria-labelledby="model-target-label">
        {MODELS.map((model) => {
          const isSelected = selected === model.id;
          const dedicated = hasDedicatedVerifier(model.id);
          return (
            <motion.button
              type="button"
              key={model.id}
              onClick={() => onSelect(model.id)}
              aria-pressed={isSelected}
              whileTap={{ scale: 0.98 }}
              className={`relative min-h-[82px] p-2.5 rounded-lg border text-left transition-all duration-200 ${
                isSelected
                  ? "border-primary bg-primary/5"
                  : "border-transparent bg-muted hover:border-border"
              }`}
            >
              {isSelected && (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="absolute top-2.5 right-2.5 w-4.5 h-4.5 rounded-full bg-primary flex items-center justify-center"
                >
                  <Check className="w-3 h-3 text-primary-foreground" />
                </motion.div>
              )}
              <div className="text-sm font-semibold text-foreground leading-tight">{model.name}</div>
              <div className="text-xs text-muted-foreground mt-0.5 font-mono">{model.provider}</div>
              <div className={`mt-1.5 text-[10px] font-medium ${dedicated ? "text-primary" : "text-muted-foreground"}`}>
                {dedicated ? t("modelDedicatedBadge") : t("modelQualityOnlyBadge")}
              </div>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
