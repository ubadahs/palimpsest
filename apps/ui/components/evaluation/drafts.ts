import type {
  AnnotationValue,
  BlindEvaluationCase,
} from "palimpsest/evaluation";

import { choiceForKey, type Choice } from "@/components/ui/choice-grid";
import { VERDICT_CHOICES } from "@/components/report/review-form";

type ValueOf<T extends AnnotationValue["task"]> = Extract<
  AnnotationValue,
  { task: T }
>;
export type Role = ValueOf<"role">["role"];
export type Grade = ValueOf<"rerank">["grades"][string];

/**
 * An answer in progress. It has the shape of the value that gets saved, with
 * blanks where the reviewer has not chosen yet.
 */
export type Draft =
  | (Omit<ValueOf<"adjudication">, "verdict"> & {
      verdict: ValueOf<"adjudication">["verdict"] | "";
    })
  | { task: "role"; role: Role | "" }
  | ValueOf<"rerank">
  | ValueOf<"span">;

export const ROLE_CHOICES: ReadonlyArray<Choice<Role>> = [
  {
    value: "substantive_attribution",
    code: "S",
    key: "1",
    name: "A finding",
    test: "Credits the paper with a specific result or measurement.",
    tone: "success",
  },
  {
    value: "background_context",
    code: "B",
    key: "2",
    name: "Background",
    test: "General knowledge, motivation or framing; no specific result.",
    tone: "muted",
  },
  {
    value: "methods_materials",
    code: "M",
    key: "3",
    name: "A method",
    test: "A protocol, reagent, dataset or tool taken from the paper.",
    tone: "muted",
  },
  {
    value: "acknowledgment_or_low_information",
    code: "A",
    key: "4",
    name: "A bare mention",
    test: "Cited in passing, with nothing attributed to it.",
    tone: "muted",
  },
  {
    value: "unclear",
    code: "U",
    key: "5",
    name: "Can't tell",
    test: "The text is too thin to say which of these it is.",
    tone: "error",
  },
];

export const GRADE_CHOICES: ReadonlyArray<{
  value: Grade;
  key: string;
  name: string;
}> = [
  { value: "direct", key: "1", name: "Bears on it" },
  { value: "contextual", key: "2", name: "Context" },
  { value: "irrelevant", key: "3", name: "Irrelevant" },
  { value: "cannot_judge", key: "4", name: "Can't judge" },
];

/** The draft a case opens with: the reviewer's last answer, or a blank one. */
export function initialDraft(
  task: Draft["task"],
  previous?: AnnotationValue,
): Draft {
  if (previous?.task === task) return previous;
  switch (task) {
    case "adjudication":
      return {
        task,
        verdict: "",
        packetQuality: "valid",
        evidenceSufficiency: "sufficient",
      };
    case "role":
      return { task, role: "" };
    case "rerank":
      return { task, grades: {} };
    case "span":
      return { task, spans: [], noValidSpan: false };
  }
}

/** The value to save, or null while the answer is incomplete. */
export function draftValue(
  item: BlindEvaluationCase,
  draft: Draft,
): AnnotationValue | null {
  switch (draft.task) {
    case "adjudication":
      return draft.verdict === "" ? null : { ...draft, verdict: draft.verdict };
    case "role":
      return draft.role === "" ? null : { task: "role", role: draft.role };
    case "rerank":
      return item.task === "rerank" &&
        item.candidates.every((candidate) => draft.grades[candidate.chunkId])
        ? draft
        : null;
    case "span":
      return draft.noValidSpan || draft.spans.length > 0 ? draft : null;
  }
}

/**
 * The draft after a key press, when the key means something for this case.
 * A verdict or role key picks that answer; a grade key grades the first
 * passage still ungraded, so a reviewer can work down the list by keyboard.
 */
export function draftAfterKey(
  item: BlindEvaluationCase,
  draft: Draft,
  key: string,
): Draft | undefined {
  switch (draft.task) {
    case "adjudication": {
      const choice = choiceForKey(VERDICT_CHOICES, key);
      return choice && { ...draft, verdict: choice.value };
    }
    case "role": {
      const choice = choiceForKey(ROLE_CHOICES, key);
      return choice && { ...draft, role: choice.value };
    }
    case "rerank": {
      const grade = GRADE_CHOICES.find((choice) => choice.key === key);
      const next =
        item.task === "rerank"
          ? item.candidates.find(
              (candidate) => !draft.grades[candidate.chunkId],
            )
          : undefined;
      return (
        grade &&
        next && {
          ...draft,
          grades: { ...draft.grades, [next.chunkId]: grade.value },
        }
      );
    }
    case "span":
      return undefined;
  }
}
