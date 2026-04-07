import { stageKeySchema } from "palimpsest/ui-contract";

import { StageDetailClient } from "@/components/stage-detail-client";
import { getRunDetailOrThrow, getStageDetailOrThrow } from "@/lib/run-queries";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";

export const dynamic = "force-dynamic";

export default async function StageDetailPage({
  params,
}: {
  params: Promise<{ runId: string; stageKey: string }>;
}) {
  ensureRunSupervisorReady();
  const { runId, stageKey } = await params;
  return (
    <StageDetailClient
      initialDetail={getStageDetailOrThrow(
        runId,
        stageKeySchema.parse(stageKey),
      )}
      initialRun={getRunDetailOrThrow(runId)}
    />
  );
}
