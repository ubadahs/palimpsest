import type { Metadata } from "next";

import { TwoHopReview } from "@/components/two-hop-review";

export const metadata: Metadata = { title: "Two-hop review | Palimpsest" };

export default function TwoHopReviewPage() {
  return <TwoHopReview />;
}
