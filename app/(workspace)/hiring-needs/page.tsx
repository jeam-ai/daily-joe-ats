import { Suspense } from "react";
import { HiringNeeds } from "@/components/hiring-needs";
import { LoadingSkeleton } from "@/components/ui";
export default function Page() {
  return (
    <Suspense fallback={<LoadingSkeleton />}>
      <HiringNeeds />
    </Suspense>
  );
}
