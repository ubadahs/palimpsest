import { describe, expect, it } from "vitest";

import { extractJsonFromModelText } from "../../src/shared/extract-json-from-text.js";

describe("extractJsonFromModelText", () => {
  it("extracts JSON from fenced code block", () => {
    const text = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
    expect(JSON.parse(extractJsonFromModelText(text))).toEqual({
      key: "value",
    });
  });

  it("extracts JSON from bare braced region", () => {
    const text = 'The output is: {"items": [1, 2, 3]}';
    expect(JSON.parse(extractJsonFromModelText(text))).toEqual({
      items: [1, 2, 3],
    });
  });

  it("extracts JSON array from bare bracketed region", () => {
    const text = "Results: [1, 2, 3]";
    expect(JSON.parse(extractJsonFromModelText(text))).toEqual([1, 2, 3]);
  });

  it("returns pure JSON text as-is", () => {
    const text = '{"pure": true}';
    expect(JSON.parse(extractJsonFromModelText(text))).toEqual({ pure: true });
  });

  it("throws when no valid JSON found", () => {
    const text = "This is just plain text with no JSON at all.";
    expect(() => extractJsonFromModelText(text)).toThrow(
      /No valid JSON found/,
    );
  });

  it("throws when LLM returns incomplete JSON", () => {
    const text = '{"key": "value", "incomplete';
    expect(() => extractJsonFromModelText(text)).toThrow(
      /No valid JSON found/,
    );
  });

  it("throws when fenced block and braces both contain invalid JSON", () => {
    const text = "```json\n{invalid}\n```\nNo valid braces here either.";
    expect(() => extractJsonFromModelText(text)).toThrow(
      /No valid JSON found/,
    );
  });

  it("prefers fenced code block over bare braces", () => {
    const text =
      '{"outer": false}\n```json\n{"inner": true}\n```';
    expect(JSON.parse(extractJsonFromModelText(text))).toEqual({
      inner: true,
    });
  });
});
