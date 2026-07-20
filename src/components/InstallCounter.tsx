import { MonitorDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";

interface InstallStats {
  total: number;
}

export function InstallCounter() {
  const { t } = useI18n();
  const [stats, setStats] = useState<InstallStats | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/installations/stats", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => {
        if (active && value?.ok) setStats({ total: value.total });
      })
      .catch(() => undefined);
    const stream = new EventSource("/api/v1/installations/stream");
    stream.addEventListener("stats", (event) => {
      try {
        const value = JSON.parse((event as MessageEvent).data);
        if (active) setStats({ total: value.total });
      } catch {
        // A later valid server event will refresh the display.
      }
    });
    return () => {
      active = false;
      stream.close();
    };
  }, []);

  if (!stats) return null;
  return (
    <a
      href="/installation-stats/"
      className="flex h-8 items-center gap-1.5 border-l border-border pl-2 text-xs text-foreground transition-colors hover:text-primary sm:gap-2 sm:pl-3"
      title={t("installCountLabel")}
      aria-label={`${t("installCountLabel")}: ${stats.total}`}
    >
      <MonitorDown className="h-4 w-4 text-primary" />
      <span className="font-semibold tabular-nums">{stats.total}</span>
    </a>
  );
}
