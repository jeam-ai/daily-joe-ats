"use client";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from "react";
import type { AppState, Application } from "@/types";
import { Toast, Button } from "./ui";
import { clientFetch } from "@/lib/client-request";
type Context = {
  state: AppState | null;
  update: (
    fn: (s: AppState) => AppState,
    confirmed?: boolean,
  ) => Promise<boolean>;
  updateApplication: (
    id: string,
    fn: (a: Application) => Application,
    confirmed?: boolean,
  ) => Promise<boolean>;
  ensureApplication: (id: string, force?: boolean) => Promise<void>;
  notify: (message: string, tone?: "success" | "error" | "info") => void;
  refresh: (options?: {
    clearDetails?: boolean;
    background?: boolean;
    force?: boolean;
  }) => Promise<void>;
  patchState: (fn: (state: AppState) => AppState) => void;
  beginDraft: () => () => void;
  saving: boolean;
  dataset: "real" | "demo";
  setDataset: (value: "real" | "demo") => void;
  demoCount: number;
  hasDemo: boolean;
};
const AppContext = createContext<Context | null>(null);
export function AppProvider({
  children,
  email,
}: {
  children: React.ReactNode;
  email?: string;
}) {
  const [state, setState] = useState<AppState | null>(null),
    [toast, setToast] = useState<{
      message: string;
      tone: "success" | "error" | "info";
    } | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false);
  const ref = useRef<AppState | null>(null);
  const detailCache = useRef(new Map<string, Application>());
  const activeDrafts = useRef(0);
  const deferredRefresh = useRef(false);
  const cacheKey = email ? `djc-workspace:${email.toLowerCase()}` : "";
  const [dataset, setDataset] = useState<"real" | "demo">("real");
  useEffect(() => {
    try {
      if (sessionStorage.getItem("djc-dataset") === "demo") setDataset("demo");
    } catch {}
  }, []);
  function switchDataset(value: "real" | "demo") {
    if (value !== dataset)
      void clientFetch("/api/demo/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: value }),
      }).catch(() => {});
    setDataset(value);
    try {
      sessionStorage.setItem("djc-dataset", value);
    } catch {}
  }
  const hasDemo =
    !!state?.hiringNeeds.some((n) => n.isDemo) ||
    (state?.applicationSummary?.demo.total || 0) > 0;
  const viewState = useMemo(
    () =>
      state
        ? {
            ...state,
            applications: state.applications.filter(
              (a) => !!a.isDemo === (dataset === "demo"),
            ),
            hiringNeeds: state.hiringNeeds.filter(
              (n) => !!n.isDemo === (dataset === "demo"),
            ),
            notifications: state.notifications.filter(
              (n) => !!n.isDemo === (dataset === "demo"),
            ),
            // Issuance has no fictional counterpart. Keep real employee
            // records out of the demonstration workspace.
            issuance: dataset === "demo" ? [] : state.issuance,
            issuanceInventory:
              dataset === "demo" ? [] : state.issuanceInventory,
          }
        : null,
    [state, dataset],
  );
  const busy = useRef(false);
  const generation = useRef(0);
  const notify = useCallback(
    (message: string, tone: "success" | "error" | "info" = "success") =>
      setToast({ message, tone }),
    [],
  );
  const patchState = useCallback(
    (fn: (state: AppState) => AppState) => {
      if (!ref.current) return;
      const next = fn(structuredClone(ref.current));
      ref.current = next;
      setState(next);
      if (cacheKey)
        try {
          sessionStorage.setItem(
            cacheKey,
            JSON.stringify({ savedAt: Date.now(), state: next }),
          );
        } catch {}
    },
    [cacheKey],
  );
  const refresh = useCallback(
    async (options?: {
      clearDetails?: boolean;
      background?: boolean;
      force?: boolean;
    }) => {
      // An intake or another user's update must never replace a form while HR
      // is typing. Queue it, then reconcile against the server as soon as the
      // draft closes so separate browsers still receive saved profile changes.
      if (activeDrafts.current && !options?.force) {
        deferredRefresh.current = true;
        return;
      }
      const request = ++generation.current;
      if (!options?.background && !ref.current) setLoading(true);
      try {
        const r = await clientFetch("/api/workspace", { cache: "no-store" });
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        if (request !== generation.current) return;
        // A refresh may have begun a moment before an HR form opened. Do not
        // apply that already-in-flight response over an active draft: doing so
        // can remount a profile editor and discard text that has not been
        // saved yet. Reconcile with the latest server state once the draft is
        // deliberately closed instead.
        if (activeDrafts.current && !options?.force) {
          deferredRefresh.current = true;
          return;
        }
        // The workspace response is intentionally bounded. An open applicant
        // outside the live queue lives in detailCache; clearing it here made a
        // background intake/processing refresh temporarily remove the profile
        // from the route and unmount its edit dialog. Only discard a cached
        // detail when this response itself contains a newer authoritative row.
        if (options?.clearDetails)
          for (const id of detailCache.current.keys())
            if (data.applications.some((application: Application) => application.id === id))
              detailCache.current.delete(id);
        const merged = {
          ...data,
          applications: [
            ...data.applications,
            ...[...detailCache.current.values()].filter(
              (application) =>
                !data.applications.some(
                  (item: Application) => item.id === application.id,
                ),
            ),
          ],
        } as AppState;
        ref.current = merged;
        setState(merged);
        if (cacheKey)
          try {
            sessionStorage.setItem(
              cacheKey,
              JSON.stringify({ savedAt: Date.now(), state: merged }),
            );
          } catch {}
        setError("");
      } catch (e) {
        if (request === generation.current) setError((e as Error).message);
      } finally {
        if (request === generation.current && !ref.current) setLoading(false);
      }
    },
    [cacheKey],
  );
  const beginDraft = useCallback(() => {
    activeDrafts.current += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeDrafts.current = Math.max(0, activeDrafts.current - 1);
      if (!activeDrafts.current && deferredRefresh.current) {
        deferredRefresh.current = false;
        void refresh({ background: true });
      }
    };
  }, [refresh]);
  useLayoutEffect(() => {
    // A short-lived, same-user cache lets the shell and current page render
    // immediately from a recent same-user cache. A background refresh always
    // replaces it with the current server-authoritative state.
    if (cacheKey)
      try {
        const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
        if (
          cached?.state &&
          typeof cached.savedAt === "number" &&
          Date.now() - cached.savedAt < 15 * 60 * 1000
        ) {
          ref.current = cached.state as AppState;
          setState(cached.state as AppState);
          setLoading(false);
        }
      } catch {}
    void refresh();
  }, [cacheKey, refresh]);
  useEffect(() => {
    let stopped = false;
    const checkForRemoteChanges = async () => {
      const current = ref.current;
      if (
        stopped ||
        !current ||
        busy.current ||
        document.visibilityState !== "visible"
      )
        return;
      try {
        const response = await clientFetch(
          `/api/workspace?revision=${encodeURIComponent(current.revision ?? 0)}`,
          { cache: "no-store" },
        );
        const result = await response.json();
        if (!response.ok || !result.changed) return;
        if (activeDrafts.current) {
          deferredRefresh.current = true;
          return;
        }
        await refresh({ background: true });
      } catch {
        // The next interval, focus, or normal route refresh retries. Do not
        // interrupt HR with a transient cross-device synchronization read.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkForRemoteChanges();
    };
    const timer = window.setInterval(() => void checkForRemoteChanges(), 30000);
    window.addEventListener("focus", checkForRemoteChanges);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", checkForRemoteChanges);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      let cached = "light";
      try {
        cached = localStorage.getItem("djc-theme") || "light";
      } catch {}
      const theme = state?.preferences.theme || cached;
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      if (state) {
        try {
          localStorage.setItem("djc-theme", theme);
        } catch {}
      }
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state?.preferences.theme]);
  const update = useCallback(
    async (fn: (s: AppState) => AppState, confirmed = false) => {
      if (!ref.current || busy.current) {
        notify("Wait for the current save to finish.", "info");
        return false;
      }
      busy.current = true;
      setSaving(true);
      ++generation.current;
      try {
        const next = fn(structuredClone(ref.current));
        const r = await clientFetch("/api/workspace", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: next, confirmed, dataset }),
        });
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        const merged = {
          ...data,
          applications: [
            ...data.applications,
            ...[...detailCache.current.values()].filter(
              (application) =>
                !data.applications.some(
                  (item: Application) => item.id === application.id,
                ),
            ),
          ],
        } as AppState;
        ref.current = merged;
        setState(merged);
        notify(
          data.syncStatus?.startsWith("Failed")
            ? `Saved. ${data.syncStatus}`
            : "Changes saved.",
          data.syncStatus?.startsWith("Failed") ? "error" : "success",
        );
        return true;
      } catch (e) {
        notify((e as Error).message, "error");
        await refresh();
        return false;
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [refresh, notify, dataset],
  );
  const updateApplication = useCallback(
    async (
      id: string,
      fn: (a: Application) => Application,
      confirmed = false,
    ) => {
      const current =
        ref.current?.applications.find((item) => item.id === id) ||
        detailCache.current.get(id);
      if (!current) {
        notify(
          "Applicant details are still loading. Try again in a moment.",
          "info",
        );
        return false;
      }
      const changed = fn(current);
      try {
        if (busy.current) {
          notify("Wait for the current save to finish.", "info");
          return false;
        }
        busy.current = true;
        setSaving(true);
        const response = await clientFetch(
          `/api/applicants/${encodeURIComponent(id)}/workflow`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ application: changed, confirmed }),
          },
        );
        const data = await response.json();
        if (!response.ok)
          throw Error(data.error || "Unable to save applicant.");
        const savedApplication = data.application as Application;
        detailCache.current.set(id, savedApplication);
        if (ref.current) {
          const merged = {
            ...ref.current,
            applications: ref.current.applications.map((item) =>
              item.id === id ? savedApplication : item,
            ),
          };
          ref.current = merged;
          setState(merged);
        }
        notify(
          data.syncStatus?.startsWith("Failed")
            ? `Saved. ${data.syncStatus}`
            : "Changes saved.",
          data.syncStatus?.startsWith("Failed") ? "error" : "success",
        );
        return true;
      } catch (error) {
        notify((error as Error).message, "error");
        await refresh();
        return false;
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [notify, refresh],
  );
  const ensureApplication = useCallback(async (id: string, force = false) => {
    if (!force && ref.current?.applications.some((item) => item.id === id)) return;
    const cached = detailCache.current.get(id);
    if (cached && !force) {
      const next = ref.current;
      if (next && !next.applications.some((item) => item.id === id)) {
        const merged = {
          ...next,
          applications: [...next.applications, cached],
        };
        ref.current = merged;
        setState(merged);
      }
      return;
    }
    const response = await clientFetch(
      `/api/applicants/${encodeURIComponent(id)}`,
      {
        cache: "no-store",
      },
    );
    const application = await response.json();
    if (!response.ok) throw Error(application.error || "Applicant not found.");
    detailCache.current.set(id, application as Application);
    const next = ref.current;
    if (next) {
      const merged = {
        ...next,
        applications: next.applications.some((item) => item.id === id)
          ? next.applications.map((item) => (item.id === id ? application : item))
          : [...next.applications, application],
      };
      ref.current = merged;
      setState(merged);
    }
  }, []);
  return (
    <AppContext.Provider
      value={{
        state: viewState,
        update,
        updateApplication,
        ensureApplication,
        notify,
        refresh,
        patchState,
        beginDraft,
        saving,
        dataset,
        setDataset: switchDataset,
        hasDemo,
        demoCount: state?.applicationSummary?.demo.total || 0,
      }}
    >
      {error && (
        <div className="error-banner" role="alert">
          {error} <Button onClick={() => void refresh()}>Retry</Button>
        </div>
      )}
      {loading && !state && (
        <div className="workspace-request-status" role="status">
          <span className="workspace-request-spinner" aria-hidden="true" />
          <span>
            <strong>Loading your workspace…</strong>
            <small>Retrieving the latest saved records.</small>
          </span>
        </div>
      )}
      {(!error || state) && children}
      {saving && (
        <div className="save-status" role="status">
          Saving…
        </div>
      )}
      {toast && (
        <Toast
          message={toast.message}
          tone={toast.tone}
          onClose={() => setToast(null)}
        />
      )}
    </AppContext.Provider>
  );
}
export function useApp() {
  const c = useContext(AppContext);
  if (!c) throw Error("Application provider missing");
  return c;
}
