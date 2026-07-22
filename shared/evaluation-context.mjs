export const EVALUATION_TIME_ZONE = "Asia/Shanghai";

const evaluationDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: EVALUATION_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function evaluationDateKey(date = new Date()) {
  const parts = Object.fromEntries(
    evaluationDateFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function fnv1a32(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function evaluationSuiteSeed(model, date = new Date(), roundIndex = 0) {
  const normalizedModel = String(model ?? "").trim().toLowerCase();
  const normalizedRound = Number.isInteger(roundIndex) && roundIndex >= 0 ? roundIndex : 0;
  const dateKey = typeof date === "string" ? date : evaluationDateKey(date);
  return fnv1a32(`quality-suite-v1|${normalizedModel}|${dateKey}|${normalizedRound}`);
}
