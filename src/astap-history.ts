export type ReleaseDescription = {
  id: string;
  content: string;
};

const normalizeWhitespace = (value: string) =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const parseAstapHistory = (paragraphs: string[]): ReleaseDescription[] => {
  const releases = new Map<string, ReleaseDescription>();

  for (const paragraph of paragraphs) {
    const text = normalizeWhitespace(paragraph);
    const match = text.match(/\bASTAP(?:_CLI)?\s+(\d{4})[-.](\d{1,2})[-.](\d{1,2})\b/i);
    if (!match) continue;

    const [, year, month, day] = match;
    const id = `ASTAP_${year}.${month.padStart(2, "0")}.${day.padStart(2, "0")}`;
    const content = normalizeWhitespace(text.slice((match.index ?? 0) + match[0].length));
    const existing = releases.get(id);

    if (!existing) {
      releases.set(id, { id, content });
    } else if (content && !existing.content.includes(content)) {
      existing.content = normalizeWhitespace(`${existing.content} ${content}`);
    }
  }

  return [...releases.values()];
};
