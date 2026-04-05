import { RunDetailClient } from "@/components/run-detail-client";
import { getRunDetailOrThrow } from "@/lib/run-queries";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  ensureRunSupervisorReady();
  const { runId } = await params;
  return <RunDetailClient initialRun={getRunDetailOrThrow(runId)} />;
}
