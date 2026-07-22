export interface OfficialGpt56Question {
  readonly id: string;
  readonly eventGroup: string;
  readonly category: string;
  readonly prompt: string;
  readonly question: string;
  readonly answer: string;
  readonly canonicalAnswer: string;
  readonly promptHint: string;
  readonly aliases: readonly string[];
}

export const OFFICIAL_GPT56_QUESTION_GROUPS: readonly (readonly Readonly<{
  idSuffix: string;
  eventGroup: string;
  category: string;
  question: string;
  canonicalAnswer: string;
  promptHint: string;
  aliases: readonly string[];
}>[])[];
export function officialGpt56QuestionGroups(profileModel: unknown): readonly (readonly OfficialGpt56Question[])[];
export function officialGpt56QuestionBank(profileModel: unknown): readonly OfficialGpt56Question[];
export function selectOfficialGpt56Questions(profileModel: unknown, randomizer?: () => number): readonly OfficialGpt56Question[];
