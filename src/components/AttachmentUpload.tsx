import { FilePlus2, Paperclip, Trash2 } from "lucide-react";
import { useRef } from "react";
import { useI18n } from "@/i18n";
import type { AttachmentDraft } from "@/lib/attachments";
import { createUuid } from "@/lib/random";

interface AttachmentUploadProps {
  value: AttachmentDraft[];
  onChange: (value: AttachmentDraft[]) => void;
  disabled?: boolean;
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function AttachmentUpload({ value, onChange, disabled = false }: AttachmentUploadProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const update = (localId: string, changes: Partial<AttachmentDraft>) => {
    onChange(value.map((item) => item.localId === localId ? { ...item, ...changes, uploaded: changes.file ? undefined : item.uploaded } : item));
  };

  return (
    <section className="border-y border-border py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Paperclip className="h-4 w-4 shrink-0 text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t("attachmentTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("attachmentIndependent")}</p>
          </div>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FilePlus2 className="h-4 w-4" />
          {t("attachmentAdd")}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          disabled={disabled}
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) {
              onChange([
                ...value,
                ...files.map((file): AttachmentDraft => ({
                  localId: createUuid(),
                  file,
                  mode: "understand",
                  instruction: "",
                  expectedIntent: "",
                })),
              ]);
            }
            event.target.value = "";
          }}
        />
      </div>

      {value.length > 0 && (
        <div className="mt-4 divide-y divide-border border-y border-border">
          {value.map((item) => (
            <div key={item.localId} className="py-3">
              <div className="flex items-start gap-3">
                <Paperclip className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="max-w-full break-all text-sm font-medium text-foreground">{item.file.name}</span>
                    <span className="text-xs font-mono text-muted-foreground">{fileSize(item.file.size)}</span>
                    {item.uploaded && <span className="text-[11px] font-medium text-success">{t("attachmentStored")}</span>}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      value={item.instruction}
                      disabled={disabled}
                      onChange={(event) => update(item.localId, { instruction: event.target.value })}
                      placeholder={t("attachmentInstructionPlaceholder")}
                      className="h-9 min-w-[14rem] flex-1 rounded-md border border-border bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onChange(value.filter((candidate) => candidate.localId !== item.localId))}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-error disabled:opacity-50"
                      title={t("attachmentRemove")}
                      aria-label={t("attachmentRemove")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
