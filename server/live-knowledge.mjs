export const LIVE_KNOWLEDGE_SCHEMA_VERSION = 2;
export const LIVE_KNOWLEDGE_QUESTION_TARGET = 4;
export const LIVE_KNOWLEDGE_REQUIRED_CORRECT = 3;

function compactHtmlText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedTitle(link) {
  if (!link || typeof link !== "object") return "";
  const titles = link.titles && typeof link.titles === "object" ? link.titles : {};
  return compactHtmlText(
    typeof titles.normalized === "string"
      ? titles.normalized
      : typeof link.normalizedtitle === "string"
        ? link.normalizedtitle
        : typeof link.title === "string"
          ? link.title.replace(/_/g, " ")
          : "",
  );
}

function titleAliases(link, title) {
  const aliases = new Set([title]);
  if (link && typeof link === "object") {
    if (typeof link.title === "string") aliases.add(link.title.replace(/_/g, " "));
    if (typeof link.normalizedtitle === "string") aliases.add(link.normalizedtitle);
    const titles = link.titles && typeof link.titles === "object" ? link.titles : {};
    if (typeof titles.canonical === "string") aliases.add(titles.canonical.replace(/_/g, " "));
  }
  return [...aliases].filter((value) => value.trim().length >= 3);
}

function makeTitleQuestion(id, prompt, link, sourcePath) {
  const expected = normalizedTitle(link);
  if (!expected) return null;
  return {
    id,
    prompt,
    kind: "text",
    expected,
    aliases: titleAliases(link, expected),
    sourcePath,
  };
}

function makeYearQuestion(index, item) {
  if (!item || !Number.isInteger(item.year)) return null;
  const expected = String(item.year);
  return {
    id: index === 0 ? "wikimedia-on-this-day-year" : `wikimedia-on-this-day-${index + 1}-year`,
    prompt: index === 0
      ? "What year is shown for the first entry in today's On This Day feed?"
      : `What year is shown for entry ${index + 1} in today's On This Day feed?`,
    kind: "number",
    expected,
    aliases: [expected],
    sourcePath: `onthisday[${index}].year`,
  };
}

function questionKey(question) {
  return `${question.kind}:${question.expected.normalize("NFKC").trim().toLowerCase()}`;
}

/**
 * Builds a fixed-size daily batch from fields that Wikimedia may omit.
 * Primary questions preserve the original mix; candidates only fill gaps.
 */
export function buildLiveKnowledgeQuestions(data) {
  const news = Array.isArray(data?.news) ? data.news : [];
  const onThisDay = Array.isArray(data?.onthisday) ? data.onthisday : [];
  const mostRead = Array.isArray(data?.mostread?.articles) ? data.mostread.articles : [];
  const primary = [];
  const candidates = [];

  const validNews = news.flatMap((item, newsIndex) => {
    const links = Array.isArray(item?.links) ? item.links : [];
    return links.map((link, linkIndex) => ({ link, newsIndex, linkIndex }));
  }).filter(({ link }) => Boolean(normalizedTitle(link)));

  const firstNews = validNews[0];
  if (firstNews) {
    primary.push(makeTitleQuestion(
      "wikimedia-news-first-title",
      "What is the title of the first linked article in the first current news item that contains article links?",
      firstNews.link,
      `news[${firstNews.newsIndex}].links[${firstNews.linkIndex}].titles.normalized`,
    ));
  }

  primary.push(makeTitleQuestion(
    "wikimedia-most-read-title",
    "What is the title of the first article in the current most-read list?",
    mostRead[0],
    "mostread.articles[0].titles.normalized",
  ));

  primary.push(makeTitleQuestion(
    "wikimedia-featured-title",
    "What is the title of today's featured article?",
    data?.tfa,
    "tfa.titles.normalized",
  ));

  const firstOnThisDayIndex = onThisDay.findIndex((item) => item && Number.isInteger(item.year));
  if (firstOnThisDayIndex >= 0) {
    primary.push(makeYearQuestion(firstOnThisDayIndex, onThisDay[firstOnThisDayIndex]));
  }

  const firstLinkFromLaterNews = validNews.filter(({ newsIndex, linkIndex }) =>
    newsIndex !== firstNews?.newsIndex && linkIndex === 0,
  );
  const remainingNewsLinks = validNews.filter(({ link, newsIndex, linkIndex }) =>
    link !== firstNews?.link &&
    !firstLinkFromLaterNews.some((candidate) =>
      candidate.newsIndex === newsIndex && candidate.linkIndex === linkIndex,
    ),
  );
  for (const { link, newsIndex, linkIndex } of [...firstLinkFromLaterNews, ...remainingNewsLinks]) {
    candidates.push(makeTitleQuestion(
      `wikimedia-news-${newsIndex + 1}-link-${linkIndex + 1}-title`,
      `What is the title of linked article ${linkIndex + 1} in current news item ${newsIndex + 1}?`,
      link,
      `news[${newsIndex}].links[${linkIndex}].titles.normalized`,
    ));
  }

  for (let index = 1; index < mostRead.length; index += 1) {
    candidates.push(makeTitleQuestion(
      `wikimedia-most-read-${index + 1}-title`,
      `What is the title of article ${index + 1} in the current most-read list?`,
      mostRead[index],
      `mostread.articles[${index}].titles.normalized`,
    ));
  }

  for (let index = 0; index < onThisDay.length; index += 1) {
    if (index === firstOnThisDayIndex) continue;
    candidates.push(makeYearQuestion(index, onThisDay[index]));
  }

  const questions = [];
  const seen = new Set();
  for (const question of [...primary, ...candidates]) {
    if (!question) continue;
    const key = questionKey(question);
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(question);
    if (questions.length === LIVE_KNOWLEDGE_QUESTION_TARGET) break;
  }
  return questions;
}
