import { Suspense } from "react";
import { Applications } from "@/components/applications";
export default function Page() {
  return (
    <Suspense>
      <Applications talent />
    </Suspense>
  );
}
