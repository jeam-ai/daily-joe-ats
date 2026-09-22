"use client";
import Link from "next/link";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <div className="empty" role="alert">
      <h1>This section could not be loaded yet.</h1>
      <p>
        Daily Joe Careers could not retrieve this section&apos;s latest saved
        records. No records were changed.
      </p>
      <div className="empty-actions">
        <button className="button primary" onClick={reset}>
          Load section again
        </button>
        <Link className="button secondary" href="/applications">
          Go to Applications
        </Link>
      </div>
    </div>
  );
}
