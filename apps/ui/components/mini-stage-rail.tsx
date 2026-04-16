import {
  getStageDefinition,
  type LogicalStageGroup,
} from "palimpsest/contract";

import { railSegmentClass } from "@/lib/status-variants";
import { cn } from "@/lib/utils";

export function MiniStageRail({ stages }: { stages: LogicalStageGroup[] }) {
  return (
    <div
      className="flex max-w-md items-center gap-1"
      role="img"
      aria-label="Pipeline stage progress"
    >
      {stages.map((group) => (
        <div
          key={group.stageKey}
          className={cn(
            "h-1.5 min-w-[6px] flex-1 rounded-full transition-colors",
            railSegmentClass(group.aggregateStatus),
          )}
          title={getStageDefinition(group.stageKey).title}
        />
      ))}
    </div>
  );
}
