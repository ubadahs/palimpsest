import {
  getStageWorkflowDefinition,
  serializeProgressEvent,
  type StageKey,
  type StageProgressEvent,
} from "../contract/index.js";

type ProgressPayload = Omit<StageProgressEvent, "stage" | "step" | "status">;

export type CliProgressReporter = {
  startStep: (step: string, payload?: ProgressPayload) => void;
  updateStep: (step: string, payload?: ProgressPayload) => void;
  completeStep: (step: string, payload?: ProgressPayload) => void;
  failStep: (step: string, payload?: ProgressPayload) => void;
};

export function createCliProgressReporter(
  stage: StageKey,
): CliProgressReporter {
  function emit(
    step: string,
    status: StageProgressEvent["status"],
    payload: ProgressPayload = {},
  ): void {
    console.info(
      serializeProgressEvent({
        stage,
        step,
        status,
        ...payload,
      }),
    );
  }

  return {
    startStep: (step, payload) => emit(step, "running", payload),
    updateStep: (step, payload) => emit(step, "running", payload),
    completeStep: (step, payload) => emit(step, "completed", payload),
    failStep: (step, payload) => emit(step, "failed", payload),
  };
}

/**
 * Wraps {@link createCliProgressReporter} and tracks the in-flight step so
 * {@link reportCliFailure} can emit `CF_PROGRESS` `failed` on unexpected errors.
 */
export function createTrackedCliProgressReporter(stage: StageKey): {
  progress: CliProgressReporter;
  reportCliFailure: (error: unknown) => void;
} {
  const base = createCliProgressReporter(stage);
  let runningStep: string | undefined;
  let lastTouchedStep: string | undefined;

  const progress: CliProgressReporter = {
    startStep: (step, payload) => {
      runningStep = step;
      lastTouchedStep = step;
      base.startStep(step, payload);
    },
    updateStep: (step, payload) => {
      runningStep = step;
      lastTouchedStep = step;
      base.updateStep(step, payload);
    },
    completeStep: (step, payload) => {
      lastTouchedStep = step;
      if (runningStep === step) {
        runningStep = undefined;
      }
      base.completeStep(step, payload);
    },
    failStep: (step, payload) => {
      runningStep = undefined;
      base.failStep(step, payload);
    },
  };

  function reportCliFailure(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const fallbackStep = getStageWorkflowDefinition(stage).steps[0]!.id;
    const step = runningStep ?? lastTouchedStep ?? fallbackStep;
    base.failStep(step, { detail });
    runningStep = undefined;
  }

  return { progress, reportCliFailure };
}
