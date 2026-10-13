export interface MethodLine {
  kind: 'step' | 'heading';
  text: string;
}

const MARKER = /^(?:\d+\s*[.)]|[-*•])\s*/;

/**
 * A method as steps. Recipes come numbered ("1. Brun kødet"), as plain lines,
 * or with short sub-headings between them ("Mornaysauce"). A line that came
 * numbered or bulleted is always a step; otherwise a short line with no
 * closing punctuation, followed by more, is taken as a heading.
 */
export function methodSteps(instructions: string): MethodLine[] {
  const lines = instructions
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ marked: MARKER.test(l), text: l.replace(MARKER, '') }))
    .filter((l) => l.text);
  return lines.map(({ marked, text }, i) => ({
    kind: !marked && text.length < 40 && !/[.!?:)]$/.test(text) && i < lines.length - 1 ? 'heading' : 'step',
    text,
  }));
}
