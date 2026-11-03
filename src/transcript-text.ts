const TRANSCRIPT_SECTION =
  /(?:^|\n)\s*(?:\d+\.\s*)?(?:\*\*)?transcribe (?:the )?speech:?(?:\*\*)?\s*/i;
const NEXT_NUMBERED_SECTION = /\n\s*\d+\.\s+(?:\*\*)?/;
const SPEAKER_LINE =
  /^\s*(?:[*-]\s*)?(?:\*\*)?Speaker\s+\d+(?:\s*\([^)]*\))?(?:\*\*)?:\s*["“](.*)["”]\s*$/gim;

export function cleanTranscript(text: string): string {
  const withoutTimestamp = text.replace(
    /^\d{4}-\d{2}-\d{2}T[^\t]+\t/,
    "",
  );
  const normalized = withoutTimestamp
    .replace(/^```(?:text)?\s*|\s*```$/gi, "")
    .trim();

  const sectionMatch = TRANSCRIPT_SECTION.exec(normalized);
  if (sectionMatch) {
    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const remaining = normalized.slice(sectionStart);
    const nextSectionIndex = NEXT_NUMBERED_SECTION.exec(remaining)?.index;
    const section = nextSectionIndex === undefined
      ? remaining
      : remaining.slice(0, nextSectionIndex);
    const spokenLines = [...section.matchAll(SPEAKER_LINE)]
      .map((match) => match[1].trim())
      .filter(Boolean);

    if (spokenLines.length > 0) {
      return spokenLines.join(" ");
    }
  }

  const speakerLines = [...normalized.matchAll(SPEAKER_LINE)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  return speakerLines.length > 0 ? speakerLines.join(" ") : normalized;
}
