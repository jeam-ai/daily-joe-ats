import { after } from "next/server";
import { runExtractionJobs } from "@/lib/server/ai-extraction";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import {
  cachedHealth,
  checkHealth,
  persistHealth,
  aiIntegration,
  settleHealthDiagnostics,
} from "@/lib/server/health";
import { auditHistory } from "@/lib/server/audit";
import { diagnosticHistory, markDiagnostic } from "@/lib/server/diagnostics";
import { SafeError, demoEnabled } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { transaction } from "@/lib/server/database";
import { controlledTestApplicant } from "@/lib/server/demo";
import {
  installSampleConfiguration,
  enrichApplicants,
} from "@/lib/server/enrichment";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    const user = await requireUser(),
      params = new URL(request.url).searchParams,
      section = params.get("section");
    if (section === "audit")
      return Response.json(await auditHistory(user, params), {
        headers: { "Cache-Control": "no-store" },
      });
    if (
      user.role !== "Admin" &&
      user.role !== "HR Generalist" &&
      user.role !== "Talent Acquisition"
    )
      throw new SafeError(
        "System monitoring requires an authorized HR role.",
        403,
      );
    const result =
      section === "ai"
        ? await aiIntegration()
        : section === "diagnostics"
          ? { issues: await diagnosticHistory() }
          : await cachedHealth();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return safeError(e);
  }
}
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await requireUser();
    if (user.role !== "Admin")
      throw new SafeError(
        "An administrator must run system checks or close diagnostic issues.",
        403,
      );
    const body = await request.json();
    if (body.action === "check") {
      const result = await checkHealth();
      after(async () => {
        await persistHealth(result, user).catch(() => undefined);
        await settleHealthDiagnostics(result).catch(() => undefined);
      });
      return Response.json(result);
    }
    if (body.action === "test-applicant") {
      if (!demoEnabled())
        throw new SafeError(
          "Demo data tools are unavailable in this environment.",
          403,
        );
      return Response.json(
        await transaction((tx) => controlledTestApplicant(tx, user)),
      );
    }
    if (body.action === "sample-config")
      return Response.json(await installSampleConfiguration(user));
    if (
      body.action === "enrich" &&
      Array.isArray(body.ids) &&
      body.ids.every((id: unknown) => typeof id === "string")
    ) {
      const result = await enrichApplicants(user, body.ids);
      after(() => runExtractionJobs(1));
      return Response.json(result);
    }
    if (
      body.action === "close" &&
      typeof body.id === "string" &&
      typeof body.note === "string"
    ) {
      await markDiagnostic(body.id, user.email, body.note);
      return Response.json({
        message: "Issue closed following your verification.",
      });
    }
    throw new SafeError("Select a supported diagnostic action.");
  } catch (e) {
    return safeError(e);
  }
}
