import { transaction, readTransaction } from "@/lib/server/database";
import { getState, saveState, audit } from "@/lib/server/repository";
import { reportIssue } from "@/lib/server/diagnostics";
import { NextResponse } from "next/server";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { config, SafeError } from "@/lib/server/config";
import { withStore, recordEvent } from "@/lib/server/store";
import { validateEmailInput } from "@/lib/google/gmail/payload";
import { sendEmail } from "@/lib/google/gmail/service";
import { safeError } from "@/lib/server/response";
export async function POST(request: Request) {
  let requestId: string | undefined;
  let email = "";
  try {
    requireOrigin(request);
    const user = await requireUser();
    email = user.email;
    if (!["Admin", "Talent Acquisition", "HR Generalist"].includes(user.role))
      throw new SafeError("Your role cannot send email.", 403);
    const text = await request.text();
    if (text.length > 15000)
      throw new SafeError("The test message is too large.");
    let input;
    let controlledTest = false;
    try {
      const parsed = JSON.parse(text);
      controlledTest = parsed.controlledTest === true;
      input = validateEmailInput(parsed, user.email);
    } catch (e) {
      throw new SafeError(
        e instanceof SyntaxError
          ? "Invalid request body."
          : (e as Error).message,
      );
    }
    if (controlledTest) {
      const fixture = (await readTransaction(getState)).applications.find(
        (a) => a.id === "demo-test-jeam" && a.isDemo,
      );
      if (
        user.role !== "Admin" ||
        !fixture ||
        fixture.applicant.email !== input.to ||
        input.to !== "deveraajeam@gmail.com"
      )
        throw new SafeError(
          "Use the designated controlled test applicant and administrator account.",
          403,
        );
      input.subject = "TEST / DEMO — " + input.subject.slice(0, 180);
      input.body =
        "CONTROLLED SYSTEM TEST — This is not a real recruitment decision or interview invitation.\n\n" +
        input.body;
    }
    const id = request.headers.get("Idempotency-Key");
    if (!id || !/^[-a-f\d]{36}$/i.test(id))
      throw new SafeError("Refresh the page before sending.");
    const connection = await withStore((s) => {
      const selected = controlledTest
        ? s.officialConnection
        : s.connection?.email === user.email
          ? s.connection
          : s.officialConnection;
      if (!selected)
        throw new SafeError("Connect Gmail before sending a test email.", 409);
      if (s.requests[id])
        throw new SafeError(
          "This send request was already processed. Check the integration history and Sent mail.",
          409,
        );
      if (
        Object.values(s.requests).some((r) => Date.now() - r.createdAt < 30000)
      )
        throw new SafeError("Wait 30 seconds between test sends.", 429);
      s.requests[id] = { status: "pending", createdAt: Date.now() };
      recordEvent(s, user.email, "gmail.test.requested", {
        requestId: id,
        recipient: input.to,
      });
      return selected;
    });
    requestId = id;
    const sent = await sendEmail(input, connection);
    await withStore((s) => {
      s.requests[id].status = "sent";
      recordEvent(s, user.email, "gmail.test.sent", {
        requestId: id,
        recipient: input.to,
        messageId: sent.messageId,
        threadId: sent.threadId || "",
      });
    });
    if (controlledTest)
      await transaction(async (tx) => {
        const state = await getState(tx),
          a = state.applications.find(
            (a) => a.id === "demo-test-jeam" && a.isDemo,
          );
        if (a) {
          a.gmailMessageId = sent.messageId;
          a.gmailThreadId = sent.threadId;
          a.originalSubject = input.subject;
          a.timeline.push({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            user: user.email,
            action: "Controlled test email sent",
            applicationId: a.id,
            metadata: {
              recipient: input.to,
              messageId: sent.messageId,
              threadId: sent.threadId || "",
              note: "TEST / DEMO only; no real recruitment email.",
            },
          });
          await saveState(tx, state, { sync: false });
        }
        await audit(
          tx,
          user.email,
          "gmail.controlled_test.sent",
          "demo-test-jeam",
          {
            recipient: input.to,
            messageId: sent.messageId,
            threadId: sent.threadId,
          },
        );
      });
    return NextResponse.json({
      message: "Test email sent successfully.",
      ...sent,
    });
  } catch (e) {
    if (requestId) await reportIssue("notification.failed");
    if (requestId)
      try {
        await withStore((s) => {
          s.requests[requestId!].status = "failed";
          recordEvent(s, email, "gmail.test.unconfirmed", {
            requestId: requestId!,
            note: "Check Sent mail before retrying.",
          });
        });
      } catch {
        /* Never expose storage or credential details. */
      }
    return safeError(e);
  }
}
