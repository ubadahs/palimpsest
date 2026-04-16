/**
 * Best-effort extraction of a JSON object/array substring from model output
 * (fenced code blocks or first braced region).
 *
 * Returns the extracted JSON string, or throws if no valid JSON can be found.
 */
export function extractJsonFromModelText(text: string): string {
  // 1. Prefer fenced code blocks (most reliable).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (isValidJson(candidate)) return candidate;
  }

  // 2. Try first braced/bracketed region.
  const braced = text.match(/(\{[\s\S]*\})/);
  if (braced?.[1] && isValidJson(braced[1])) {
    return braced[1];
  }

  const bracketed = text.match(/(\[[\s\S]*\])/);
  if (bracketed?.[1] && isValidJson(bracketed[1])) {
    return bracketed[1];
  }

  // 3. Fall back to the full text (may still parse if the LLM returned pure JSON).
  if (isValidJson(text.trim())) {
    return text.trim();
  }

  throw new Error(
    `No valid JSON found in LLM response (${String(text.length)} chars). First 200 chars: ${text.slice(0, 200)}`,
  );
}

function isValidJson(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}
