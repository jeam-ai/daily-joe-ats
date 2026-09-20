"use client";
import Image from "next/image";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
        <p className="eyebrow">Workspace unavailable</p>
        <h1>We hit a small snag.</h1>
        <p className="status-copy">
          Your records are safe. Refresh this workspace and we&apos;ll try
          again.
        </p>
        <button className="button primary" onClick={() => reset()}>
          Try again
        </button>
      </div>
    </main>
  );
}
