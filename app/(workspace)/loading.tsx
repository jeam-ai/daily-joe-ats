import Image from "next/image";

export default function Loading() {
  return (
    <main className="workspace-loading" aria-busy="true">
      <div className="workspace-loading-card">
        <Image
          src="/daily-joe-logo-blue.png"
          alt="Daily Joe Careers"
          width={126}
          height={55}
          priority
        />
        <span className="workspace-loading-kicker">DAILY JOE CAREERS ATS</span>
        <h1>Preparing your workspace</h1>
        <p>Loading applicants, hiring needs, and the latest team updates.</p>
        <div className="workspace-loading-track" aria-hidden="true">
          <i />
        </div>
        <span className="sr-only">Loading workspace…</span>
      </div>
    </main>
  );
}
