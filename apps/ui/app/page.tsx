import { HealthPanel } from "@/components/health-panel";
import { RunList } from "@/components/run-list";
import { getDashboardData } from "@/lib/run-queries";
import { getRepoRoot } from "@/lib/root-path";
import { ensureRunSupervisorReady } from "@/lib/run-supervisor";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  ensureRunSupervisorReady();
  const { health, runs } = await getDashboardData();

  return (
    <div className="space-y-6">
      <HealthPanel health={health} workspaceRoot={getRepoRoot()} />
      <RunList initialRuns={runs} />
    </div>
  );
}
