"use client";
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#f5f7fb",
          color: "#25374a",
          fontFamily: "Arial, sans-serif",
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
        }}
      >
        <main style={{ maxWidth: 480, padding: 32, textAlign: "center" }}>
          <img
            src="/daily-joe-logo-blue.png"
            width="200"
            alt="Daily Joe Careers"
          />
          <h1>We couldn’t open this workspace.</h1>
          <p>Your saved records are safe. Try again, or return to sign in.</p>
          <button
            onClick={reset}
            style={{ padding: "12px 20px", cursor: "pointer" }}
          >
            Try Again
          </button>
          <p>
            <a href="/login">Return to sign in</a>
          </p>
        </main>
      </body>
    </html>
  );
}
