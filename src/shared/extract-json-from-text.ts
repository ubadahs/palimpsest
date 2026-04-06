/**
 * Best-effort extraction of a JSON object/array substring from model output
 * (fenced code blocks or first braced region).
 */
export function extractJsonFromModelText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const braced = text.match(/\{[\s\S]*\}/);
  if (braced?.[0]) {
    return braced[0];
  }

  return text;
}
