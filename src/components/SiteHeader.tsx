import { BookOpen, FlaskConical } from "lucide-react";
import { Link, NavLink } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { InstallCounter } from "@/components/InstallCounter";
import { useI18n } from "@/i18n";

export function SiteHeader() {
  const { lang, setLang, t } = useI18n();
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${
      isActive
        ? "bg-foreground text-primary-foreground"
        : "text-muted-foreground hover:bg-muted hover:text-foreground"
    }`;

  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-3 py-3 sm:px-6 lg:px-8">
        <Link to="/" className="mr-auto flex min-w-0 items-center gap-2.5" aria-label={t("appTitle")}>
          <Logo size={34} />
          <div className="min-w-0">
            <div className="text-lg font-bold text-foreground sm:text-xl">{t("appTitle")}</div>
            <div className="hidden text-xs text-muted-foreground sm:block">{t("appSubtitle")}</div>
          </div>
        </Link>

        <nav className="order-3 flex w-full items-center gap-1 border-t border-border pt-3 sm:order-none sm:w-auto sm:border-0 sm:pt-0" aria-label="Primary">
          <NavLink to="/" end className={navClass}>
            <FlaskConical className="h-4 w-4" />
            {t("navDetection")}
          </NavLink>
          <NavLink to="/api-docs" className={navClass}>
            <BookOpen className="h-4 w-4" />
            {t("navApiDocs")}
          </NavLink>
        </nav>

        <InstallCounter />

        <div className="flex shrink-0 overflow-hidden rounded-md border border-border text-xs sm:text-sm">
          <button
            type="button"
            onClick={() => setLang("en")}
            className={`h-8 px-2.5 transition-colors ${lang === "en" ? "bg-foreground text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            EN
          </button>
          <button
            type="button"
            onClick={() => setLang("zh")}
            className={`h-8 px-2.5 transition-colors ${lang === "zh" ? "bg-foreground text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            中文
          </button>
        </div>
      </div>
    </header>
  );
}
