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
  notify: (message: string, tone?: "success" | "error" | "info") => void;
  refresh: () => Promise<void>;
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
    !!state?.applications.some((a) => a.isDemo);
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
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const r = await clientFetch("/api/workspace", { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      if (request !== generation.current) return;
      ref.current = data;
      setState(data);
      if (cacheKey)
        try {
          sessionStorage.setItem(
            cacheKey,
            JSON.stringify({ savedAt: Date.now(), state: data }),
          );
        } catch {}
      setError("");
    } catch (e) {
      if (request === generation.current) setError((e as Error).message);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [cacheKey]);
  useLayoutEffect(() => {
    // A short-lived, same-user cache lets the shell and current page render
    // immediately during a cold Sheets read. A background refresh always
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
        ref.current = data;
        setState(data);
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
    (id: string, fn: (a: Application) => Application, confirmed = false) =>
      update(
        (s) => ({
          ...s,
          applications: s.applications.map((a) => (a.id === id ? fn(a) : a)),
        }),
        confirmed,
      ),
    [update],
  );
  return (
    <AppContext.Provider
      value={{
        state: viewState,
        update,
        updateApplication,
        notify,
        refresh,
        saving,
        dataset,
        setDataset: switchDataset,
        hasDemo,
        demoCount: state?.applications.filter((a) => a.isDemo).length || 0,
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
