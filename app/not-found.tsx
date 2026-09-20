import Link from "next/link";
import Image from "next/image";

export default function NotFound() {
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
        <p className="eyebrow">404 · Page not found</p>
        <h1>This page took a coffee break.</h1>
        <p className="status-copy">
          The workspace link may have moved, or the record is no longer
          available.
        </p>
        <Link className="button primary" href="/">
          Return to dashboard
        </Link>
      </div>
    </main>
  );
}
