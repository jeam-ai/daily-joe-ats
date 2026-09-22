"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

type Phase = "idle" | "loading" | "slow";

function isWorkspaceNavigation(anchor: HTMLAnchorElement) {
  if (
    anchor.target ||
    anchor.hasAttribute("download") ||
    anchor.getAttribute("rel") === "external"
  )
    return false;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin || url.pathname.startsWith("/api/"))
    return false;
  const current = new URL(window.location.href);
  return url.pathname !== current.pathname || url.search !== current.search;
}

/**
 * Keeps shared layouts responsive while an App Router navigation is in flight.
 * Route segments can load from the Sheets gateway after the click, so feedback
 * must begin before the destination component is ready to render.
 */
export function RouteFeedback() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [phase, setPhase] = useState<Phase>("idle");
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const begin = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const source = event.target;
      if (!(source instanceof Element)) return;
      const anchor = source.closest("a[href]");
      if (anchor instanceof HTMLAnchorElement && isWorkspaceNavigation(anchor))
        setPhase("loading");
    };
    document.addEventListener("click", begin, true);
    return () => document.removeEventListener("click", begin, true);
  }, []);

  useEffect(() => {
    // A changed route or filter means the target segment has arrived. Hash-only
    // links are excluded above because they do not need a workspace fetch.
    setPhase("idle");
  }, [pathname, search]);

  useEffect(() => {
    if (slowTimer.current) clearTimeout(slowTimer.current);
    if (phase === "loading")
      slowTimer.current = setTimeout(() => setPhase("slow"), 6000);
    return () => {
      if (slowTimer.current) clearTimeout(slowTimer.current);
    };
  }, [phase]);

  const busy = phase !== "idle";
  return (
    <div
      className={`route-feedback ${busy ? "is-visible" : ""}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="route-feedback-card" role={busy ? "status" : undefined}>
        <span className="route-feedback-bar" aria-hidden="true">
          <i />
        </span>
        <span>
          <strong>{phase === "slow" ? "Still loading…" : "Loading…"}</strong>
          <small>
            {phase === "slow"
              ? "Retrieving the latest saved records. You can keep this page open."
              : "Opening the selected workspace section."}
          </small>
        </span>
      </div>
    </div>
  );
}
