import { useState, useRef } from "react";
import { BadgeCheck, CircleHelp, Clipboard, KeyRound, Search, X } from "lucide-react";
import { useI18n } from "@/i18n";
import type { ApiProtocol } from "@/lib/apiProtocol";
import { hasDedicatedVerifier } from "@/lib/authenticity";
import { getModelDisplayName, resolveModelProfile } from "@/lib/models";

const PROVIDERS = [
  { name: "Anthropic Official", url: "https://api.anthropic.com" },
  { name: "OpenAI Official", url: "https://api.openai.com" },
  { name: "Google AI Studio", url: "https://generativelanguage.googleapis.com" },
];

interface ApiConfigProps {
  url: string;
  apiKey: string;
  onUrlChange: (url: string) => void;
  onApiKeyChange: (key: string) => void;
  modelId: string;
  profileModelId: string | null;
  onModelIdChange: (modelId: string) => void;
  protocol: ApiProtocol;
  onProtocolChange: (protocol: ApiProtocol) => void;
}

export function ApiConfig({
  url,
  apiKey,
  onUrlChange,
  onApiKeyChange,
  modelId,
  profileModelId,
  onModelIdChange,
  protocol,
  onProtocolChange,
}: ApiConfigProps) {
  const { t } = useI18n();
  const [showDropdown, setShowDropdown] = useState(false);
  const [search, setSearch] = useState("");
  const [keyFocused, setKeyFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = PROVIDERS.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.url.toLowerCase().includes(search.toLowerCase())
  );

  const maskedKey = apiKey
    ? apiKey.length > 9
      ? `${apiKey.slice(0, 7)}${"•".repeat(Math.min(apiKey.length - 9, 10))}${apiKey.slice(-2)}`
      : "•".repeat(apiKey.length)
    : "";
  const modelResolution = resolveModelProfile(modelId);
  const effectiveProfileId = profileModelId;
  const effectiveProfileName = effectiveProfileId ? getModelDisplayName(effectiveProfileId) : "-";
  const effectiveProfileDedicated = Boolean(effectiveProfileId && hasDedicatedVerifier(effectiveProfileId));

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* URL Input */}
        <div>
          <label htmlFor="api-endpoint-url" className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider font-mono">
            {t("apiEndpointLabel")}
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              ref={inputRef}
              id="api-endpoint-url"
              type="text"
              name="api-endpoint-url"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={url}
              onChange={(e) => {
                onUrlChange(e.target.value);
                setSearch(e.target.value);
              }}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
              placeholder={t("apiEndpointPlaceholder")}
              className="w-full h-11 pl-10 pr-4 rounded-lg bg-muted border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
            />
            {showDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg z-50 max-h-60 overflow-y-auto">
                {filtered.map((p) => (
                  <button
                    type="button"
                    key={p.url}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted transition-colors"
                    onMouseDown={() => {
                      onUrlChange(p.url);
                      setSearch(p.url);
                      setShowDropdown(false);
                    }}
                  >
                    <div>
                      <div className="text-sm font-medium text-foreground">{p.name}</div>
                      <div className="text-xs font-mono text-muted-foreground">{p.url}</div>
                    </div>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <div className="px-4 py-3 text-sm text-muted-foreground">{t("apiNoProvidersFound")}</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* API Key Input */}
        <div>
          <label id="api-key-label" htmlFor="access-token-input" className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider font-mono">
            {t("apiKeyLabel")}
          </label>
          <div className="relative">
            <KeyRound aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            {keyFocused ? (
              <input
                type="text"
                id="access-token-input"
                name="access-token-input"
                autoComplete="one-time-code"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                inputMode="text"
                enterKeyHint="done"
                data-lpignore="true"
                data-1p-ignore="true"
                data-form-type="other"
                value={apiKey}
                aria-labelledby="api-key-label"
                onChange={(e) => onApiKeyChange(e.target.value)}
                onBlur={() => setKeyFocused(false)}
                autoFocus
                className="w-full h-11 pl-10 pr-20 rounded-lg bg-muted border border-border text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
              />
            ) : (
              <div
                id="access-token-input"
                role="textbox"
                tabIndex={0}
                aria-label={t("apiKeyLabel")}
                onClick={() => {
                  inputRef.current?.blur();
                  setShowDropdown(false);
                  setKeyFocused(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setKeyFocused(true);
                  }
                }}
                className="w-full h-11 pl-10 pr-20 rounded-lg bg-muted border border-border text-sm font-mono text-foreground flex items-center cursor-text select-none"
              >
                {apiKey ? maskedKey : <span className="text-muted-foreground">{t("apiKeyPlaceholder")}</span>}
              </div>
            )}
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {apiKey && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(apiKey);
                    }}
                    className="p-1 rounded hover:bg-foreground/5 text-muted-foreground transition-colors"
                    title={t("apiActionCopy")}
                    aria-label={t("apiActionCopy")}
                  >
                    <Clipboard aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onApiKeyChange("")}
                    className="p-1 rounded hover:bg-foreground/5 text-muted-foreground transition-colors"
                    title={t("apiActionClear")}
                    aria-label={t("apiActionClear")}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-4">
        <label htmlFor="custom-model-id" className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider font-mono">
          {t("modelCustomLabel")}
        </label>
        <div className="relative">
          <input
            id="custom-model-id"
            type="text"
            name="custom-model-id"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={modelId}
            onChange={(event) => onModelIdChange(event.target.value)}
            placeholder={t("modelCustomPlaceholder")}
            className="w-full h-10 px-3 pr-10 rounded-lg bg-muted border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
          />
          {modelId && (
            <button
              type="button"
              onClick={() => onModelIdChange("")}
              className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              title={t("apiActionClear")}
              aria-label={t("apiActionClear")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          {modelResolution.match === "unknown" && modelId.trim()
            ? <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            : <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
          <span>
            {!modelId.trim()
              ? `${t("modelCustomUsingSelected")} ${effectiveProfileName} (${effectiveProfileId ?? "-"})`
              : modelResolution.profileModelId
                ? modelResolution.profileModelId === effectiveProfileId
                  ? `${t("modelCustomRecognized")} ${effectiveProfileName} · ${effectiveProfileDedicated ? t("modelDedicatedBadge") : t("modelQualityOnlyBadge")}`
                  : `${t("modelCustomRecognized")} ${getModelDisplayName(modelResolution.profileModelId)}；${t("modelCustomProfileOverride")} ${effectiveProfileName}`
                : `${t("modelCustomUnknown")} ${effectiveProfileName} · ${effectiveProfileDedicated ? t("modelDedicatedBadge") : t("modelQualityOnlyBadge")}`}
          </span>
        </div>
      </div>
      <div className="mt-4">
        <label htmlFor="api-protocol" className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider font-mono">
          {t("apiProtocolLabel")}
        </label>
        <select
          id="api-protocol"
          value={protocol}
          onFocus={() => setShowDropdown(false)}
          onChange={(event) => {
            setShowDropdown(false);
            onProtocolChange(event.target.value as ApiProtocol);
          }}
          className="w-full h-10 px-3 rounded-lg bg-muted border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
        >
          <option value="auto">{t("apiProtocolAuto")}</option>
          <option value="anthropic">{t("apiProtocolAnthropic")}</option>
          <option value="openai-chat">{t("apiProtocolOpenAIChat")}</option>
          <option value="openai-responses">{t("apiProtocolOpenAIResponses")}</option>
          <option value="openai-images">{t("apiProtocolOpenAIImages")}</option>
          <option value="google-generative">{t("apiProtocolGoogleGenerative")}</option>
        </select>
      </div>
    </div>
  );
}
