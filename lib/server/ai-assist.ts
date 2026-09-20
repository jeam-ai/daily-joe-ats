import "server-only";
import { createHash } from "node:crypto";
import type { User } from "@/types";
import type { AiProfile, AiRun } from "@/types/operations";
import { aiEligibility } from "@/lib/ai-assist";
import { canEdit } from "@/lib/data-policy";
import {
  transaction,
  readTransaction,
  readRecord,
  putRecord,
  type Transaction,
} from "./database";
import { getState } from "./repository";
import { writeAudit } from "./audit";
import { seal, unseal } from "@/lib/auth/security";
import { config, SafeError } from "./config";
import {
  aiConfigured,
  geminiProvider,
  classifyAiError,
  type AiProvider,
  type AssistInput,
} from "./ai-provider";
import { recordIssue, resolveIssue } from "./diagnostics";

const VERSION = "assist-v1";
async function source(tx: Transaction, id: string, user: User) {
  const a = (await getState(tx)).applications.find(
    (v) => v.id === id && !v.deletedAt,
  );
  if (!a) throw new SafeError("Applicant not found.", 404);
  const resume = a.resumeId
    ? (
        await tx.query("SELECT extracted_text FROM resumes WHERE id=$1", [
          a.resumeId,
        ])
      )[0]
    : undefined;
  const fullDocument = resume
    ? unseal<string>(String(resume.extracted_text), config().encryptionKey)
    : "";
  const document = fullDocument.slice(0, 40000);
  const input: AssistInput = {
    document,
    position: a.position,
    location: a.location,
    qualifications: a.screening.criteria,
    warnings: [
      ...(a.extraction?.warnings || []),
      ...(fullDocument.length > 40000
        ? [
            "Only the first 40,000 extracted characters were submitted; review the original for remaining evidence.",
          ]
        : []),
    ],
  };
  const sourceVersion = createHash("sha256")
    .update(
      JSON.stringify({
        version: VERSION,
        input,
        applicant: a.applicant,
        resumeHash: a.resumeHash,
        extractedVersion: createHash("sha256")
          .update(fullDocument)
          .digest("hex"),
      }),
    )
    .digest("hex");
  return {
    a,
    input,
    sourceVersion,
    canRun: !a.isDemo && canEdit(user, a) && !!document.trim(),
  };
}
interface StoredAssist {
  enabled: boolean;
  latest?: string;
}
async function runById(tx: Transaction, id?: string) {
  if (!id) return undefined;
  const encrypted = await readRecord<{ sealed: string }>(tx, "ai_runs", id);
  return encrypted
    ? unseal<AiRun>(encrypted.sealed, config().encryptionKey)
    : undefined;
}
async function saveRun(tx: Transaction, run: AiRun) {
  await putRecord(tx, "ai_runs", run.id, {
    sealed: seal(run, config().encryptionKey),
  });
  await putRecord(tx, "ai_usage", run.id, {
    id: run.id,
    status: run.status,
    requestedAt: run.requestedAt,
    completedAt: run.completedAt,
    errorCode: run.errorCode,
    model: run.model,
  });
}
export async function aiProfile(id: string, user: User): Promise<AiProfile> {
  const profile = await readTransaction(async (tx) => {
    const s = await source(tx, id, user),
      settings = await readRecord<StoredAssist>(tx, "ai_settings", id);
    let run = await runById(tx, settings?.latest);
    // A crashed worker must not leave the UI spinning. Retry explicitly acquires
    // a fresh lease; an expired worker is fenced from publishing its result.
    if (
      run?.status === "Running" &&
      Date.now() - Date.parse(run.requestedAt) > 90000
    )
      run = {
        ...run,
        status: "Failed",
        completedAt: new Date().toISOString(),
        errorCode: "timeout",
        error:
          "AI Assist was interrupted. Retry explicitly. System Analysis is unchanged.",
      };
    return {
      configured: aiConfigured(),
      enabled: settings?.enabled || false,
      eligible: aiEligibility(s.a),
      sourceVersion: s.sourceVersion,
      stale: !!run && run.sourceVersion !== s.sourceVersion,
      run,
      canRun: s.canRun,
    };
  });
  if (profile.run?.errorCode === "timeout" && profile.run.status === "Failed") {
    const expired = profile.run;
    await transaction(async (tx) => {
      const stored = await runById(tx, expired.id);
      if (stored?.status !== "Running") return;
      await saveRun(tx, expired);
      await writeAudit(tx, "System", "ai.failed", id, {
        runId: expired.id,
        status: "Failed",
        errorCode: "timeout",
      });
      await recordIssue("ai.timeout", { entityId: id }, tx);
    });
  }
  return profile;
}
export async function setAiEnabled(id: string, user: User, enabled: boolean) {
  await transaction(async (tx) => {
    const s = await source(tx, id, user);
    if (!canEdit(user, s.a) || s.a.isDemo)
      throw new SafeError(
        "AI Assist is unavailable for this record or role.",
        403,
      );
    const settings = (await readRecord<StoredAssist>(
      tx,
      "ai_settings",
      id,
    )) || { enabled: false };
    if (settings.enabled === enabled) return;
    settings.enabled = enabled;
    await putRecord(tx, "ai_settings", id, settings);
    await writeAudit(
      tx,
      user.email,
      enabled ? "ai.enabled" : "ai.disabled",
      id,
      { provider: "Gemini" },
    );
  });
}
export async function runAiAssist(
  id: string,
  user: User,
  fresh = false,
  provider: AiProvider = geminiProvider(),
) {
  const claim = await transaction(async (tx) => {
    const s = await source(tx, id, user);
    if (!s.canRun)
      throw new SafeError(
        "AI Assist requires a real applicant, readable extracted text and permission to edit this applicant.",
        403,
      );
    const settings = (await readRecord<StoredAssist>(
      tx,
      "ai_settings",
      id,
    )) || { enabled: false };
    const previous = await runById(tx, settings.latest);
    if (
      previous?.status === "Running" &&
      Date.now() - Date.parse(previous.requestedAt) < 90000
    )
      return { run: previous, cached: true, input: s.input };
    if (
      !fresh &&
      previous?.status === "Completed" &&
      previous.sourceVersion === s.sourceVersion &&
      previous.model === provider.model
    ) {
      if (!settings.enabled) {
        await putRecord(tx, "ai_settings", id, { ...settings, enabled: true });
        await writeAudit(tx, user.email, "ai.enabled", id, { cached: true });
      }
      return { run: previous, cached: true, input: s.input };
    }
    if (previous?.status === "Running") {
      previous.status = "Failed";
      previous.completedAt = new Date().toISOString();
      previous.errorCode = "timeout";
      previous.error = "The previous request was interrupted.";
      await saveRun(tx, previous);
      await recordIssue("ai.timeout", { entityId: id, user: user.email }, tx);
    }
    const run: AiRun = {
      id: crypto.randomUUID(),
      applicationId: id,
      provider: "Gemini",
      model: provider.model,
      requestedBy: user.email,
      requestedAt: new Date().toISOString(),
      status: "Running",
      sourceVersion: s.sourceVersion,
    };
    if (!settings.enabled)
      await writeAudit(tx, user.email, "ai.enabled", id, {
        provider: "Gemini",
      });
    await putRecord(tx, "ai_settings", id, { enabled: true, latest: run.id });
    await saveRun(tx, run);
    await writeAudit(
      tx,
      user.email,
      previous?.status === "Failed"
        ? "ai.retried"
        : fresh
          ? "ai.refreshed"
          : "ai.requested",
      id,
      {
        provider: "Gemini",
        model: run.model,
        runId: run.id,
        sourceVersion: s.sourceVersion,
        status: "Running",
      },
    );
    return { run, cached: false, input: s.input };
  });
  if (claim.cached) return claim.run;
  const run = claim.run;
  try {
    run.result = await provider.analyze(claim.input);
    run.status = "Completed";
  } catch (error) {
    const safe = classifyAiError(error);
    run.status = "Failed";
    run.error = safe.message;
    run.errorCode = safe.code;
  }
  run.completedAt = new Date().toISOString();
  await transaction(async (tx) => {
    const settings = await readRecord<StoredAssist>(tx, "ai_settings", id);
    if (
      settings?.latest !== run.id ||
      (await runById(tx, run.id))?.status !== "Running"
    )
      return; // A newer or expired request owns the lease.
    await saveRun(tx, run);
    await writeAudit(
      tx,
      user.email,
      run.status === "Completed" ? "ai.completed" : "ai.failed",
      id,
      {
        provider: "Gemini",
        model: run.model,
        runId: run.id,
        status: run.status,
        errorCode: run.errorCode,
      },
    );
    if (run.status === "Failed")
      await recordIssue(
        run.errorCode === "rate_limit"
          ? "ai.rate_limit"
          : run.errorCode === "timeout"
            ? "ai.timeout"
            : run.errorCode === "invalid_response"
              ? "ai.invalid_response"
              : "ai.provider",
        { entityId: id, user: user.email },
        tx,
      );
  });
  if (run.status === "Completed")
    for (const category of [
      "ai.timeout",
      "ai.rate_limit",
      "ai.invalid_response",
      "ai.provider",
    ] as const)
      await resolveIssue(category, { entityId: id });
  return run;
}
export async function aiUsage() {
  return readTransaction(async (tx) => {
    const rows = (
      await tx.query("SELECT payload FROM records WHERE collection=$1", [
        "ai_usage",
      ])
    ).map(
      (r) =>
        JSON.parse(String(r.payload)) as {
          status: string;
          requestedAt: string;
          completedAt?: string;
          errorCode?: string;
          model: string;
        },
    );
    const period = new Date().toISOString().slice(0, 7),
      current = rows.filter((r) => r.requestedAt.startsWith(period));
    return {
      period,
      requests: current.length,
      completed: current.filter((r) => r.status === "Completed").length,
      failed: current.filter((r) => r.status === "Failed").length,
      lastSuccess: rows
        .filter((r) => r.status === "Completed")
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0]
        ?.completedAt,
      lastError: rows
        .filter((r) => r.status === "Failed")
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0],
    };
  });
}
