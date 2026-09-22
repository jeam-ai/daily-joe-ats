"use client";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    window.setTimeout(() => setRetrying(false), 12000);
    reset();
  };
  return (
    <main className="status-page">
      <div className="status-card">
        <div className="status-brand">
          <Image
            src="/daily-joe-logo-blue.png"
            alt="Daily Joe Careers"
            width={180}
            height={79}
            priority
          />
          <span>CAREERS ATS</span>
        </div>
        <p className="eyebrow">Workspace loading issue</p>
        <h1>We couldn&apos;t load Daily Joe Careers right now.</h1>
        <p className="status-copy">
          The latest workspace data could not be retrieved. Your saved records
          have not been changed.
        </p>
        <p className="status-help">
          Try loading the workspace again. If this continues, open System Health
          after signing in to review the storage connection.
        </p>
        <div className="status-actions">
          <button
            className="button primary"
            onClick={retry}
            disabled={retrying}
          >
            {retrying ? "Loading workspace…" : "Load workspace again"}
          </button>
          <Link className="button secondary" href="/applications">
            Go to Applications
          </Link>
        </div>
      </div>
    </main>
  );
}
