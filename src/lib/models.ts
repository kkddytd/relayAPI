export interface ModelOption {
  id: string;
  tab: string;
  name: string;
  provider: "Anthropic" | "OpenAI" | "Google" | "Zhipu AI";
  capability: "chat" | "image";
  aliases?: readonly string[];
}

export const MODELS: ModelOption[] = [
  { id: "gpt-5.6-sol", tab: "gpt56sol", name: "GPT 5.6 Sol", provider: "OpenAI", capability: "chat" },
  { id: "gpt-5.6-terra", tab: "gpt56terra", name: "GPT 5.6 Terra", provider: "OpenAI", capability: "chat" },
  { id: "gpt-5.6-luna", tab: "gpt56luna", name: "GPT 5.6 Luna", provider: "OpenAI", capability: "chat" },
  { id: "gpt-5.6", tab: "gpt56", name: "GPT 5.6", provider: "OpenAI", capability: "chat" },
  { id: "gpt-5.5", tab: "gpt55", name: "GPT 5.5", provider: "OpenAI", capability: "chat" },
  { id: "gpt-5.4", tab: "gpt54", name: "GPT 5.4", provider: "OpenAI", capability: "chat" },
  { id: "gpt-5", tab: "gpt5", name: "GPT 5", provider: "OpenAI", capability: "chat" },
  { id: "gpt-4.1", tab: "gpt41", name: "GPT 4.1", provider: "OpenAI", capability: "chat" },
  { id: "gpt-4.1-mini", tab: "gpt41mini", name: "GPT 4.1 mini", provider: "OpenAI", capability: "chat" },
  { id: "gpt-4o", tab: "gpt4o", name: "GPT 4o", provider: "OpenAI", capability: "chat" },
  { id: "gpt-4o-mini", tab: "gpt4omini", name: "GPT 4o mini", provider: "OpenAI", capability: "chat" },
  { id: "o3", tab: "o3", name: "o3", provider: "OpenAI", capability: "chat" },
  { id: "o4-mini", tab: "o4mini", name: "o4-mini", provider: "OpenAI", capability: "chat" },
  { id: "claude-fable-5", tab: "fable5", name: "Fable 5", provider: "Anthropic", capability: "chat", aliases: ["claude-5-fable", "fable5", "fable-5"] },
  { id: "claude-opus-4-8", tab: "opus48", name: "Opus 4.8", provider: "Anthropic", capability: "chat", aliases: ["claude-4-8-opus"] },
  { id: "claude-sonnet-5", tab: "sonnet5", name: "Sonnet 5", provider: "Anthropic", capability: "chat" },
  { id: "claude-sonnet-4-6", tab: "sonnet46", name: "Sonnet 4.6", provider: "Anthropic", capability: "chat" },
  { id: "gpt-image-2", tab: "gptimage2", name: "GPT Image 2", provider: "OpenAI", capability: "image" },
  { id: "glm-5.2", tab: "glm52", name: "GLM 5.2", provider: "Zhipu AI", capability: "chat" },
  { id: "claude-opus-4-7", tab: "opus47", name: "Opus 4.7", provider: "Anthropic", capability: "chat", aliases: ["claude-4-7-opus"] },
  { id: "claude-opus-4-6", tab: "opus46", name: "Opus 4.6", provider: "Anthropic", capability: "chat", aliases: ["claude-4-6-opus"] },
  { id: "claude-haiku-4-5", tab: "haiku45", name: "Haiku 4.5", provider: "Anthropic", capability: "chat" },
  { id: "gemini-3.1-pro-preview", tab: "gemini31", name: "Gemini 3.1 Pro", provider: "Google", capability: "chat" },
];

export const KNOWN_MODEL_IDS = new Set(MODELS.map((model) => model.id));
const KNOWN_MODEL_IDS_LONGEST_FIRST = [...KNOWN_MODEL_IDS].sort((left, right) => right.length - left.length);
const ALLOWED_ALIAS_SUFFIX = /^(?:latest|preview|chat-latest|fast|1m|\d{2}-\d{2}|\d{3}|\d{4}(?:-\d{2}(?:-\d{2})?)?|\d{8})$/i;
const EXPLICIT_ALIASES = new Map(
  MODELS.flatMap((model) => (model.aliases ?? []).map((alias) => [alias.toLowerCase(), model.id] as const)),
);

export type ModelProfileMatch = "exact" | "alias" | "unknown";

export interface ModelProfileResolution {
  requestedId: string;
  profileModelId: string | null;
  match: ModelProfileMatch;
}

function stripModelDecorator(value: string): string {
  return value.replace(/\[(?:1m|fast)\]$/i, "").trim();
}

export function resolveModelProfile(modelId: string): ModelProfileResolution {
  const requestedId = modelId.trim();
  const normalized = requestedId.toLowerCase();
  if (!normalized || normalized.includes("/")) {
    return { requestedId, profileModelId: null, match: "unknown" };
  }

  if (KNOWN_MODEL_IDS.has(normalized)) {
    return { requestedId, profileModelId: normalized, match: "exact" };
  }

  const undecorated = stripModelDecorator(normalized);
  if (KNOWN_MODEL_IDS.has(undecorated)) {
    return { requestedId, profileModelId: undecorated, match: "alias" };
  }

  const explicit = EXPLICIT_ALIASES.get(undecorated);
  if (explicit) return { requestedId, profileModelId: explicit, match: "alias" };

  const fable = undecorated.match(/^(?:claude-(?:fable-5|5-fable|fable5)|fable5|fable-5)(?:-(.+))?$/i);
  if (fable && (!fable[1] || ALLOWED_ALIAS_SUFFIX.test(fable[1]))) {
    return { requestedId, profileModelId: "claude-fable-5", match: "alias" };
  }

  const reversedClaude = undecorated.match(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)(?:-(.+))?$/i);
  if (reversedClaude && (!reversedClaude[4] || ALLOWED_ALIAS_SUFFIX.test(reversedClaude[4]))) {
    const canonical = `claude-${reversedClaude[3].toLowerCase()}-${reversedClaude[1]}-${reversedClaude[2]}`;
    if (KNOWN_MODEL_IDS.has(canonical)) {
      return { requestedId, profileModelId: canonical, match: "alias" };
    }
  }

  for (const knownId of KNOWN_MODEL_IDS_LONGEST_FIRST) {
    if (!undecorated.startsWith(`${knownId}-`)) continue;
    const suffix = undecorated.slice(knownId.length + 1);
    if (ALLOWED_ALIAS_SUFFIX.test(suffix)) {
      return { requestedId, profileModelId: knownId, match: "alias" };
    }
  }

  return { requestedId, profileModelId: null, match: "unknown" };
}

export function resolveModelProfileId(modelId: string): string | null {
  return resolveModelProfile(modelId).profileModelId;
}

export function modelIdsShareProfile(left: string, right: string): boolean {
  const leftProfile = resolveModelProfileId(left);
  const rightProfile = resolveModelProfileId(right);
  return Boolean(leftProfile && rightProfile && leftProfile === rightProfile);
}

export function getModelDisplayName(id: string): string {
  return MODELS.find((model) => model.id === id)?.name ?? id;
}

export function isImageModel(id: string): boolean {
  const profileId = resolveModelProfileId(id);
  return MODELS.find((model) => model.id === profileId)?.capability === "image" || /^gpt-image-/i.test(id.trim());
}
