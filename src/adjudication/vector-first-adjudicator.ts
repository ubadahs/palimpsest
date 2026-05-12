import type {
  AdjudicationRecord,
  AdjudicationVerdict,
  AuditSample,
  FidelityVectorTrace,
  VectorRoutingCategoricalEscalationReason,
  VectorRoutingDecision,
} from "../domain/types.js";
import { adjudicationVerdictSchema } from "../domain/types.js";
import type { LLMClient } from "../integrations/llm-client.js";
import { pMap } from "../shared/p-map.js";
import {
  buildFidelityVectorTrace,
  DEFAULT_FIDELITY_VECTOR_MODEL,
  generateFidelityVectorSamples,
} from "./fidelity-vector-scorer.js";
import {
  decideAdaptiveSampling,
  decideCategoricalEscalation,
  deriveVectorFirstJudgeConfidence,
  deriveVectorFirstRetrievalQuality,
} from "./vector-first-routing.js";

export type VectorFirstOptions = {
  model?: string;
  initialSamples: number;
  maxSamples: number;
  temperature: number;
  concurrency?: number;
};

export type RunCategoricalAdjudication = (
  set: AuditSample,
) => Promise<AuditSample>;

export type RunVectorFirstAdjudicationParams = {
  set: AuditSample;
  client: LLMClient;
  options: VectorFirstOptions;
  runCategoricalAdjudication: RunCategoricalAdjudication;
  onProgress?: (index: number, total: number) => void;
};

type VectorFirstCandidate = {
  recordId: string;
  record: AdjudicationRecord;
  trace?: FidelityVectorTrace;
  routingDecision: VectorRoutingDecision;
};

type VectorFirstPreparedRecord = {
  recordId: string;
  candidate: VectorFirstCandidate;
  needsCategorical: boolean;
};

const ROUTING_VERSION = "vector-routing-v1";

export async function runVectorFirstAdjudication({
  set,
  client,
  options,
  runCategoricalAdjudication,
  onProgress,
}: RunVectorFirstAdjudicationParams): Promise<AuditSample> {
  validateVectorFirstOptions(options);

  const active = set.records.filter((record) => !record.excluded);
  const originalByRecordId = new Map(
    set.records.map((record) => [record.recordId, record]),
  );
  const model = options.model ?? DEFAULT_FIDELITY_VECTOR_MODEL;
  const concurrency = options.concurrency ?? 2;
  const timestamp = new Date().toISOString();
  let completed = 0;

  const prepared = await pMap(
    active,
    async (record) => {
      const result = await prepareVectorFirstRecord({
        record,
        client,
        model,
        temperature: options.temperature,
        initialSamples: options.initialSamples,
        maxSamples: options.maxSamples,
        timestamp,
      });
      if (!result.needsCategorical) {
        completed++;
        onProgress?.(completed, active.length);
      }
      return result;
    },
    { concurrency },
  );

  const escalationIds = new Set(
    prepared
      .filter((entry) => entry.needsCategorical)
      .map((entry) => entry.recordId),
  );
  const categoricalById = new Map<string, AdjudicationRecord>();
  let categoricalResult: AuditSample | undefined;

  if (escalationIds.size > 0) {
    const escalationSubset: AuditSample = {
      ...set,
      records: [...escalationIds].flatMap((recordId) => {
        const original = originalByRecordId.get(recordId);
        return original ? [original] : [];
      }),
    };
    categoricalResult = await runCategoricalAdjudication(escalationSubset);
    for (const record of categoricalResult.records) {
      categoricalById.set(record.recordId, record);
    }
  }

  const preparedById = new Map(
    prepared.map((entry) => [entry.recordId, entry.candidate]),
  );

  const records = set.records.map((record) => {
    if (record.excluded) return record;

    const candidate = preparedById.get(record.recordId);
    if (!candidate) return record;

    const categoricalRecord = categoricalById.get(record.recordId);
    if (categoricalRecord) {
      completed++;
      onProgress?.(completed, active.length);
      return mergeCategoricalEscalation(candidate, categoricalRecord);
    }

    return candidate.record;
  });

  return buildVectorFirstResult({
    base: set,
    records,
    timestamp,
    categoricalResult,
  });
}

export function validateVectorFirstOptions(options: VectorFirstOptions): void {
  if (!Number.isInteger(options.initialSamples) || options.initialSamples < 1) {
    throw new Error("vectorFirstInitialSamples must be a positive integer");
  }
  if (!Number.isInteger(options.maxSamples) || options.maxSamples < 1) {
    throw new Error("vectorFirstMaxSamples must be a positive integer");
  }
  if (options.maxSamples < options.initialSamples) {
    throw new Error(
      "vectorFirstMaxSamples must be greater than or equal to vectorFirstInitialSamples",
    );
  }
}

async function prepareVectorFirstRecord(params: {
  record: AdjudicationRecord;
  client: LLMClient;
  model: string;
  temperature: number;
  initialSamples: number;
  maxSamples: number;
  timestamp: string;
}): Promise<VectorFirstPreparedRecord> {
  const {
    record,
    client,
    model,
    temperature,
    initialSamples,
    maxSamples,
    timestamp,
  } = params;

  try {
    const initial = await generateFidelityVectorSamples({
      record,
      client,
      model,
      temperature,
      sampleCount: initialSamples,
    });
    let samples = initial;
    let trace = buildFidelityVectorTrace({ samples, model, temperature });
    const adaptiveDecision = decideAdaptiveSampling(record, trace.aggregate);

    if (adaptiveDecision.triggered && samples.length < maxSamples) {
      const additional = await generateFidelityVectorSamples({
        record,
        client,
        model,
        temperature,
        sampleCount: maxSamples - samples.length,
        startIndex: samples.length,
      });
      samples = [...samples, ...additional];
      trace = buildFidelityVectorTrace({ samples, model, temperature });
    }

    const escalationDecision = decideCategoricalEscalation(
      record,
      trace.aggregate,
    );
    const routingDecision = buildRoutingDecision({
      finalVerdictSource: escalationDecision.triggered
        ? "categorical_escalation"
        : "axis_derived",
      initialSampleCount: initialSamples,
      finalSampleCount: trace.sampleCount,
      adaptiveSamplingReasons: adaptiveDecision.reasons,
      categoricalEscalationReasons: escalationDecision.reasons,
      ...(!escalationDecision.triggered
        ? {
            acceptedAxisDerivedVerdict: adjudicationVerdictSchema.parse(
              trace.aggregate.axisDerivedVerdict,
            ),
          }
        : {}),
    });

    return {
      recordId: record.recordId,
      needsCategorical: escalationDecision.triggered,
      candidate: {
        recordId: record.recordId,
        record: escalationDecision.triggered
          ? {
              ...record,
              fidelityVectorTrace: trace,
              vectorRoutingDecision: routingDecision,
            }
          : buildAxisDerivedRecord({
              record,
              trace,
              routingDecision,
              model,
              timestamp,
            }),
        trace,
        routingDecision,
      },
    };
  } catch {
    const reason: VectorRoutingCategoricalEscalationReason =
      "vector_trace_failed";
    const routingDecision = buildRoutingDecision({
      finalVerdictSource: "categorical_escalation",
      initialSampleCount: initialSamples,
      finalSampleCount: 0,
      adaptiveSamplingReasons: [],
      categoricalEscalationReasons: [reason],
    });

    return {
      recordId: record.recordId,
      needsCategorical: true,
      candidate: {
        recordId: record.recordId,
        record: {
          ...record,
          vectorRoutingDecision: routingDecision,
        },
        routingDecision,
      },
    };
  }
}

function buildAxisDerivedRecord(params: {
  record: AdjudicationRecord;
  trace: FidelityVectorTrace;
  routingDecision: VectorRoutingDecision;
  model: string;
  timestamp: string;
}): AdjudicationRecord {
  const { record, trace, routingDecision, model, timestamp } = params;
  const aggregate = trace.aggregate;
  const verdict = adjudicationVerdictSchema.parse(aggregate.axisDerivedVerdict);

  return {
    ...record,
    comparison: buildAxisDerivedComparison(record, trace),
    verdict,
    rationale: `Axis-derived verdict: ${aggregate.axisDerivedVerdictReason}`,
    retrievalQuality: deriveVectorFirstRetrievalQuality(aggregate),
    judgeConfidence: deriveVectorFirstJudgeConfidence(aggregate),
    adjudicator: `vector-first:${model}:axis-derived`,
    adjudicatedAt: timestamp,
    telemetry: undefined,
    fidelityVectorTrace: trace,
    vectorRoutingDecision: routingDecision,
  } satisfies AdjudicationRecord;
}

function mergeCategoricalEscalation(
  candidate: VectorFirstCandidate,
  categoricalRecord: AdjudicationRecord,
): AdjudicationRecord {
  const categoricalVerdict = categoricalRecord.verdict;
  const trace =
    candidate.trace && categoricalVerdict
      ? buildFidelityVectorTrace({
          samples: candidate.trace.samples,
          model: candidate.trace.model,
          temperature: candidate.trace.temperature,
          canonicalVerdict: categoricalVerdict,
        })
      : candidate.trace;
  const routingDecision: VectorRoutingDecision = {
    ...candidate.routingDecision,
    ...(categoricalVerdict ? { categoricalVerdict } : {}),
  };

  return {
    ...categoricalRecord,
    ...(trace ? { fidelityVectorTrace: trace } : {}),
    vectorRoutingDecision: routingDecision,
  } satisfies AdjudicationRecord;
}

function buildRoutingDecision(params: {
  finalVerdictSource: VectorRoutingDecision["finalVerdictSource"];
  initialSampleCount: number;
  finalSampleCount: number;
  adaptiveSamplingReasons: VectorRoutingDecision["adaptiveSamplingReasons"];
  categoricalEscalationReasons: VectorRoutingDecision["categoricalEscalationReasons"];
  acceptedAxisDerivedVerdict?: AdjudicationVerdict;
}): VectorRoutingDecision {
  const decision: VectorRoutingDecision = {
    version: ROUTING_VERSION,
    adjudicationMode: "vector_first",
    finalVerdictSource: params.finalVerdictSource,
    triggeredAdaptiveSampling: params.adaptiveSamplingReasons.length > 0,
    triggeredCategoricalAdjudicator:
      params.finalVerdictSource === "categorical_escalation",
    initialSampleCount: params.initialSampleCount,
    finalSampleCount: params.finalSampleCount,
    adaptiveSamplingReasons: params.adaptiveSamplingReasons,
    categoricalEscalationReasons: params.categoricalEscalationReasons,
  };

  if (params.acceptedAxisDerivedVerdict) {
    decision.acceptedAxisDerivedVerdict = params.acceptedAxisDerivedVerdict;
  }

  return decision;
}

function buildAxisDerivedComparison(
  record: AdjudicationRecord,
  trace: FidelityVectorTrace,
): string {
  const claim = record.groundedSeedClaimText ?? record.rubricQuestion;
  const means = trace.aggregate.meanAxes;

  return `The citing paper attributes to the cited paper: ${claim}. Axis-derived from the fidelity-vector aggregate using rule ${trace.aggregate.axisDerivedVerdictRule}: support ${means.support.toFixed(2)}, grounding ${means.evidenceGrounding.toFixed(2)}, claim identity ${means.claimIdentity.toFixed(2)}, and uncertainty ${means.uncertainty.toFixed(2)}.`;
}

function buildVectorFirstResult(params: {
  base: AuditSample;
  records: AdjudicationRecord[];
  timestamp: string;
  categoricalResult: AuditSample | undefined;
}): AuditSample {
  const { base, records, timestamp, categoricalResult } = params;
  const result: AuditSample & Record<string, unknown> = {
    ...base,
    records,
    createdAt: timestamp,
  };

  if (categoricalResult?.runTelemetry) {
    result.runTelemetry = categoricalResult.runTelemetry;
  }

  const rawCategorical = categoricalResult as
    | Record<string, unknown>
    | undefined;
  for (const key of [
    "firstPassTelemetry",
    "escalationTelemetry",
    "escalationCount",
  ]) {
    const value = rawCategorical?.[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}
