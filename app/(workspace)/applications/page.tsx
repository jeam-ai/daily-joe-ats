import { Suspense } from "react";
import { Applications } from "@/components/applications";
import { LoadingSkeleton } from "@/components/ui";
export default function Page() {
  return (
    <Suspense fallback={<LoadingSkeleton />}>
      <Applications />
    </Suspense>
  );
}
