"use client";
import Link from "next/link";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <div className="empty" role="alert">
      <h1>Workspace temporarily unavailable.</h1>
      <p>
        Daily Joe Careers could not retrieve the latest saved workspace data.
        No records were changed.
      </p>
      <div className="empty-actions">
        <button className="button primary" onClick={reset}>
          Retry workspace
        </button>
        <Link className="button secondary" href="/applications">
          Go to Applications
        </Link>
      </div>
    </div>
  );
}
