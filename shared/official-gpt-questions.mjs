const rawQuestionGroups = [
  [
    {
      idSuffix: "001",
      eventGroup: "bulgaria-euro",
      category: "Business & Economy",
      question: "Which country adopted the euro on January 1, 2026, becoming the eurozone's 21st member?",
      canonicalAnswer: "Bulgaria",
      promptHint: "Answer with the country name only.",
      aliases: ["bulgaria", "保加利亚", "保加利亞"],
    },
    {
      idSuffix: "002",
      eventGroup: "bulgaria-euro",
      category: "Business & Economy",
      question: "Which currency did Bulgaria adopt on January 1, 2026?",
      canonicalAnswer: "Euro",
      promptHint: "Answer with the currency name only.",
      aliases: ["euro", "欧元", "歐元"],
    },
    {
      idSuffix: "003",
      eventGroup: "bulgaria-euro",
      category: "Business & Economy",
      question: "Which currency did Bulgaria replace when it adopted the euro on January 1, 2026?",
      canonicalAnswer: "Bulgarian lev",
      promptHint: "Answer with the previous currency name only.",
      aliases: ["bulgarian lev", "lev", "保加利亚列弗", "保加利亞列弗"],
    },
    {
      idSuffix: "004",
      eventGroup: "bulgaria-euro",
      category: "Business & Economy",
      question: "Bulgaria became which numbered member of the eurozone when it adopted the euro on January 1, 2026?",
      canonicalAnswer: "21st",
      promptHint: "Answer with the ordinal number only.",
      aliases: ["21st", "21", "twenty-first", "twenty first", "第二十一", "第21"],
    },
  ],
  [
    {
      idSuffix: "005",
      eventGroup: "equatorial-guinea-capital",
      category: "Politics",
      question: "What city officially became the capital of Equatorial Guinea in January 2026, replacing Malabo?",
      canonicalAnswer: "Ciudad de la Paz",
      promptHint: "Answer with the city name only.",
      aliases: ["ciudad de la paz", "和平城"],
    },
    {
      idSuffix: "006",
      eventGroup: "equatorial-guinea-capital",
      category: "Politics",
      question: "Ciudad de la Paz became the capital of which country in January 2026?",
      canonicalAnswer: "Equatorial Guinea",
      promptHint: "Answer with the country name only.",
      aliases: ["equatorial guinea", "赤道几内亚", "赤道幾內亞"],
    },
    {
      idSuffix: "007",
      eventGroup: "equatorial-guinea-capital",
      category: "Politics",
      question: "Which city did Ciudad de la Paz replace as the capital of Equatorial Guinea in January 2026?",
      canonicalAnswer: "Malabo",
      promptHint: "Answer with the former capital's name only.",
      aliases: ["malabo", "马拉博", "馬拉博"],
    },
  ],
  [
    {
      idSuffix: "008",
      eventGroup: "byd-ev-sales",
      category: "Business & Technology",
      question: "Which automaker surpassed Tesla as the world's best-selling electric-vehicle maker based on 2025 sales announced in January 2026?",
      canonicalAnswer: "BYD",
      promptHint: "Answer with the automaker name only.",
      aliases: ["byd", "byd auto", "比亚迪", "比亞迪"],
    },
    {
      idSuffix: "009",
      eventGroup: "byd-ev-sales",
      category: "Business & Technology",
      question: "Which automaker did BYD overtake to become the world's best-selling electric-vehicle maker based on 2025 sales announced in January 2026?",
      canonicalAnswer: "Tesla",
      promptHint: "Answer with the automaker name only.",
      aliases: ["tesla", "tesla inc", "特斯拉"],
    },
    {
      idSuffix: "010",
      eventGroup: "byd-ev-sales",
      category: "Business & Technology",
      question: "Which company became the world's top-selling electric-vehicle automaker after 2025 sales figures were reported in January 2026?",
      canonicalAnswer: "BYD",
      promptHint: "Answer with the company name only.",
      aliases: ["byd", "byd auto", "比亚迪", "比亞迪"],
    },
  ],
  [
    {
      idSuffix: "011",
      eventGroup: "swiss-presidency",
      category: "Politics",
      question: "Who was sworn in as President of Switzerland on January 1, 2026?",
      canonicalAnswer: "Guy Parmelin",
      promptHint: "Answer with the person's name only.",
      aliases: ["guy parmelin", "parmelin", "居伊 帕姆兰", "居伊 帕姆蘭"],
    },
    {
      idSuffix: "012",
      eventGroup: "swiss-presidency",
      category: "Politics",
      question: "Guy Parmelin became president of which country on January 1, 2026?",
      canonicalAnswer: "Switzerland",
      promptHint: "Answer with the country name only.",
      aliases: ["switzerland", "瑞士"],
    },
    {
      idSuffix: "013",
      eventGroup: "swiss-presidency",
      category: "Politics",
      question: "Who did Guy Parmelin succeed as President of Switzerland in January 2026?",
      canonicalAnswer: "Karin Keller-Sutter",
      promptHint: "Answer with the person's name only.",
      aliases: [
        "karin keller-sutter",
        "karin keller sutter",
        "keller-sutter",
        "keller sutter",
        "卡琳 凯勒 祖特尔",
        "卡琳 凱勒 祖特爾",
      ],
    },
  ],
  [
    {
      idSuffix: "014",
      eventGroup: "us-who-withdrawal",
      category: "International Organizations",
      question: "Which country became the first member state to withdraw from the World Health Organization in January 2026?",
      canonicalAnswer: "United States",
      promptHint: "Answer with the country name only.",
      aliases: ["united states", "the us", "the u s", "美国", "美國"],
    },
    {
      idSuffix: "015",
      eventGroup: "us-who-withdrawal",
      category: "International Organizations",
      question: "Which international organization did the United States formally withdraw from in January 2026?",
      canonicalAnswer: "World Health Organization",
      promptHint: "Answer with the organization name only.",
      aliases: ["world health organization", "who", "世界卫生组织", "世界衛生組織"],
    },
    {
      idSuffix: "016",
      eventGroup: "us-who-withdrawal",
      category: "International Organizations",
      question: "On what date did the United States withdrawal from the World Health Organization take effect?",
      canonicalAnswer: "January 22, 2026",
      promptHint: "Answer with the full date only.",
      aliases: [
        "january 22 2026",
        "jan 22 2026",
        "22 january 2026",
        "22 jan 2026",
        "2026-01-22",
        "2026/1/22",
        "2026年1月22日",
      ],
    },
  ],
];

function profilePrefix(profileModel) {
  const normalized = String(profileModel ?? "").trim().toLowerCase();
  if (normalized === "gpt-5.6-sol") return "SOL";
  if (normalized === "gpt-5.6-terra") return "TERRA";
  return null;
}

function publicQuestion(prefix, question) {
  return Object.freeze({
    id: `${prefix}-JAN-${question.idSuffix}`,
    eventGroup: question.eventGroup,
    category: question.category,
    prompt: question.question,
    question: question.question,
    answer: question.canonicalAnswer,
    canonicalAnswer: question.canonicalAnswer,
    promptHint: question.promptHint,
    aliases: Object.freeze([...question.aliases]),
  });
}

export const OFFICIAL_GPT56_QUESTION_GROUPS = Object.freeze(
  rawQuestionGroups.map((group) => Object.freeze(group.map((question) => Object.freeze({ ...question, aliases: Object.freeze([...question.aliases]) })))),
);

export function officialGpt56QuestionGroups(profileModel) {
  const prefix = profilePrefix(profileModel);
  if (!prefix) return Object.freeze([]);
  return Object.freeze(
    OFFICIAL_GPT56_QUESTION_GROUPS.map((group) => Object.freeze(group.map((question) => publicQuestion(prefix, question)))),
  );
}

export function officialGpt56QuestionBank(profileModel) {
  return Object.freeze(officialGpt56QuestionGroups(profileModel).flat());
}

export function selectOfficialGpt56Questions(profileModel, randomizer = Math.random) {
  return Object.freeze(
    officialGpt56QuestionGroups(profileModel).map((group) => {
      const value = Number(randomizer());
      const normalized = Number.isFinite(value) ? Math.min(0.9999999999999999, Math.max(0, value)) : 0;
      return group[Math.floor(normalized * group.length)];
    }),
  );
}
