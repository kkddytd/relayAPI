export interface OpenAiProbeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface OpenAiProbeRequestOptions {
  model: string;
  messages: OpenAiProbeMessage[];
  maxOutputTokens?: number;
}

export function isOpenAiReasoningModel(model: unknown): boolean;
export function buildOpenAiResponsesProbeBody(options: OpenAiProbeRequestOptions): {
  model: string;
  input: OpenAiProbeMessage[];
  max_output_tokens: number;
  reasoning?: { effort: "low" };
  store: false;
};
export function buildOpenAiChatProbeBody(options: OpenAiProbeRequestOptions): {
  model: string;
  messages: OpenAiProbeMessage[];
  max_completion_tokens: number;
  stream: true;
  stream_options: { include_usage: true };
  temperature?: 0;
};
