import type { AppState } from "@/types";
import { createSeed } from "./seed";
export interface RecruitmentRepository {
  load(): Promise<AppState>;
  save(state: AppState): Promise<void>;
}
// Development adapter. Replace through this interface with an authenticated API adapter.
export const mockRepository: RecruitmentRepository = {
  async load() {
    const saved = localStorage.getItem("daily-joe-demo-v1");
    if (saved) {
      try {
        const value = JSON.parse(saved);
        if (
          value.version === 1 &&
          Array.isArray(value.applications) &&
          Array.isArray(value.hiringNeeds) &&
          value.preferences
        )
          return value;
      } catch {
        /* Ignore damaged demo state. */
      }
    }
    return createSeed();
  },
  async save(state) {
    localStorage.setItem("daily-joe-demo-v1", JSON.stringify(state));
  },
};
