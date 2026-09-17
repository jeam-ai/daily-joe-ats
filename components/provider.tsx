"use client";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import type { AppState, Application } from "@/types";
import { Toast, Button } from "./ui";
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
  notify: (message: string) => void;
  refresh: () => Promise<void>;
  saving: boolean;
};
const AppContext = createContext<Context | null>(null);
export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState | null>(null),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const ref = useRef<AppState | null>(null);
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/workspace", { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      ref.current = data;
      setState(data);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useLayoutEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const theme = state?.preferences.theme || "system";
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme);
    apply();
    document.documentElement.classList.remove("theme-pending");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state?.preferences.theme]);
  const update = useCallback(
    async (fn: (s: AppState) => AppState, confirmed = false) => {
      if (!ref.current || busy.current) {
        setToast("Wait for the current save to finish.");
        return false;
      }
      busy.current = true;
      setSaving(true);
      try {
        const next = fn(structuredClone(ref.current));
        const r = await fetch("/api/workspace", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: next, confirmed }),
        });
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        ref.current = data;
        setState(data);
        setToast(
          data.syncStatus?.startsWith("Failed")
            ? `Saved. ${data.syncStatus}`
            : "Saved to the recruitment workspace.",
        );
        return true;
      } catch (e) {
        setToast((e as Error).message);
        await refresh();
        return false;
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [refresh],
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
        state,
        update,
        updateApplication,
        notify: setToast,
        refresh,
        saving,
      }}
    >
      {error ? (
        <div className="error-banner" role="alert">
          {error} <Button onClick={() => void refresh()}>Retry</Button>
        </div>
      ) : (
        children
      )}
      {saving && (
        <div className="save-status" role="status">
          Saving…
        </div>
      )}
      {toast && <Toast message={toast} onClose={() => setToast("")} />}
    </AppContext.Provider>
  );
}
export function useApp() {
  const c = useContext(AppContext);
  if (!c) throw Error("Application provider missing");
  return c;
}
