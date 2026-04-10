import { DashboardHomeClient } from "@/components/dashboard-home-client";
import { getDashboardData } from "@/lib/run-queries";
import { getRepoRoot } from "@/lib/root-path";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  ensureRunSupervisorReady();
  const { health, stats, runs } = await getDashboardData();

  return (
    <DashboardHomeClient
      initialHealth={health}
      initialRuns={runs}
      initialStats={stats}
      workspaceRoot={getRepoRoot()}
    />
  );
}
