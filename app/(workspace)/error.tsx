"use client";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <div className="empty" role="alert">
      <h1>Something interrupted the workspace</h1>
      <p>Your saved records are safe. Try again or return to Applications.</p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
