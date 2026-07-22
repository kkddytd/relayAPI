export function isOpenAiReasoningModel(model) {
  return /^(?:gpt-5|o[1-9](?:$|[-.]))/i.test(String(model ?? "").trim());
}

export function buildOpenAiResponsesProbeBody({ model, messages, maxOutputTokens = 10240 }) {
  return {
    model,
    input: messages,
    max_output_tokens: maxOutputTokens,
    ...(isOpenAiReasoningModel(model) ? { reasoning: { effort: "low" } } : {}),
    store: false,
  };
}

export function buildOpenAiChatProbeBody({ model, messages, maxOutputTokens = 10240 }) {
  return {
    model,
    messages,
    max_completion_tokens: maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(!isOpenAiReasoningModel(model) ? { temperature: 0 } : {}),
  };
}
