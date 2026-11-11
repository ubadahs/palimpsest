import type {
  AnnotationEvent,
  BlindEvaluationCase,
  GradingRequest,
} from "palimpsest/evaluation";

export type EvaluationTask = BlindEvaluationCase["task"];

/** What a reviewer sees of a dataset: cases without labels or machine output. */
export type DatasetView = {
  datasetId: string;
  name: string;
  cases: BlindEvaluationCase[];
  annotations: AnnotationEvent[];
  requests: GradingRequest[];
};

/** The four kinds of question, in a reviewer's words. */
export const TASKS: ReadonlyArray<{
  task: EvaluationTask;
  name: string;
  question: string;
}> = [
  {
    task: "adjudication",
    name: "Verdicts",
    question: "Is the citation faithful to the paper it cites?",
  },
  {
    task: "role",
    name: "Citation roles",
    question: "What is the citing paper using the citation for?",
  },
  {
    task: "rerank",
    name: "Passage relevance",
    question: "Which passages of the cited paper bear on the claim?",
  },
  {
    task: "span",
    name: "Claim spans",
    question: "Which words of the citing text carry the claim?",
  },
];

/** A reviewer's latest annotation on a case, draft or final. */
export function ownAnnotation(
  annotations: readonly AnnotationEvent[],
  caseId: string,
  reviewer: string,
): AnnotationEvent | undefined {
  return annotations.findLast(
    (event) => event.caseId === caseId && event.reviewer === reviewer,
  );
}

/** The cases whose latest annotation by this reviewer is final. */
export function gradedCaseIds(
  annotations: readonly AnnotationEvent[],
  reviewer: string,
): Set<string> {
  const latest = new Map<string, AnnotationEvent>();
  for (const event of annotations)
    if (event.reviewer === reviewer) latest.set(event.caseId, event);
  return new Set(
    [...latest.values()]
      .filter((event) => event.status === "final")
      .map((event) => event.caseId),
  );
}

/** The cases a grading session walks through, and why. */
export type GradingQueue = {
  title: string;
  purpose: string;
  caseIds: readonly string[];
};

/**
 * The queue a grading link names: one request, or every case of one task.
 * Undefined when the link names neither.
 */
export function resolveQueue(
  view: DatasetView,
  link: { request?: string | undefined; task?: string | undefined },
): GradingQueue | undefined {
  const request = view.requests.find(
    (entry) => entry.requestId === link.request,
  );
  if (request) return request;
  const kind = TASKS.find((entry) => entry.task === link.task);
  return (
    kind && {
      title: kind.name,
      purpose: kind.question,
      caseIds: view.cases
        .filter((item) => item.task === kind.task)
        .map((item) => item.caseId),
    }
  );
}
