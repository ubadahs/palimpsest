"use client";

import { useEffect, useState } from "react";
import type {
  StageArtifactPointer,
  StageKey,
} from "palimpsest/ui-contract";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function ArtifactTabs({
  runId,
  stageKey,
  stageTitle,
  artifactPointers,
}: {
  runId: string;
  stageKey: StageKey;
  stageTitle?: string;
  artifactPointers: StageArtifactPointer[];
}) {
  const [activeTab, setActiveTab] = useState("primary");
  const [content, setContent] = useState<Record<string, string>>({});
  const availableKinds = artifactPointers.map((pointer) => pointer.kind);

  useEffect(() => {
    const nextTab = availableKinds.includes(activeTab)
      ? activeTab
      : availableKinds[0];
    if (!nextTab || content[nextTab]) {
      return;
    }

    void (async () => {
      const response = await fetch(
        `/api/runs/${runId}/stages/${stageKey}/artifacts/${nextTab}`,
      );
      const text = await response.text();
      setContent((current) => ({ ...current, [nextTab]: text }));
    })();
  }, [activeTab, availableKinds, content, runId, stageKey]);

  if (availableKinds.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-[var(--text-muted)]">
          No artifacts recorded for this stage yet.
        </CardContent>
      </Card>
    );
  }

  const initialKind = availableKinds[0]!;

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <h3 className="font-semibold text-[var(--text)]">
          Stage output
          {stageTitle ? (
            <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
              {stageTitle}
            </span>
          ) : null}
        </h3>
      </CardHeader>
      <CardContent>
        <Tabs
          defaultValue={initialKind}
          onValueChange={setActiveTab}
          value={activeTab || initialKind}
        >
          <TabsList>
            {availableKinds.map((kind) => (
              <TabsTrigger key={kind} value={kind}>
                {kind}
              </TabsTrigger>
            ))}
          </TabsList>
          {availableKinds.map((kind) => (
            <TabsContent key={kind} value={kind}>
              <ScrollArea className="h-[420px] rounded-[24px] border border-[var(--border)] bg-[#1f1b17]">
                <pre className="whitespace-pre-wrap p-5 text-xs leading-6 text-[#efe6da]">
                  {content[kind] ?? "Loading artifact…"}
                </pre>
              </ScrollArea>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}
