import { AlertTriangle, CheckCircle2, ExternalLink, EyeOff, FileSearch } from "lucide-react";
import { useI18n } from "@/i18n";
import type { AttachmentAnalysisReport } from "@/lib/attachments";

function attachmentUrl(name?: string) {
  return name ? `/upload/${encodeURIComponent(name)}` : null;
}

export function AttachmentAnalysisPanel({ report }: { report: AttachmentAnalysisReport }) {
  const { t } = useI18n();
  const recognizedCount = report.recognized_count ?? report.items.filter((item) => (
    item.recognition_status === "recognized" || (!item.recognition_status && item.status === "completed")
  )).length;
  const recognitionTotal = report.recognition_total ?? report.total;

  return (
    <section data-testid="attachment-analysis" className="mt-5 border-t border-border pt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileSearch className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">{t("attachmentAnalysisTitle")}</h3>
        </div>
        <span className="text-xs text-muted-foreground">
          {t("attachmentRecognitionSummary")}: {recognizedCount}/{recognitionTotal}
        </span>
      </div>
      <div className="divide-y divide-border border-y border-border">
        {report.items.map((item, index) => {
          const recognized = item.recognition_status === "recognized" || (!item.recognition_status && item.status === "completed");
          const StatusIcon = recognized ? CheckCircle2 : item.recognition_reason === "model_did_not_observe_attachment" ? EyeOff : AlertTriangle;
          const statusLabel = recognized ? t("attachmentStatusRecognized") : t("attachmentStatusNotObserved");
          const url = item.url || attachmentUrl(item.name);
          return (
            <div key={`${item.attachment_id}-${index}`} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="flex min-w-0 items-center gap-2">
                <StatusIcon className={`h-4 w-4 shrink-0 ${recognized ? "text-success" : "text-warning"}`} />
                <div className="min-w-0">
                  <div className="break-all text-sm font-medium text-foreground">{item.name || item.attachment_id}</div>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-[11px] text-primary underline-offset-2 hover:underline"
                    >
                      <span className="break-all">{url}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  )}
                </div>
              </div>
              <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${recognized ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
                <StatusIcon className="h-3.5 w-3.5" />
                {statusLabel}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{t("attachmentNotScored")}</p>
    </section>
  );
}
