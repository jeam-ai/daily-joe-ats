import "server-only";
import {
  readTransaction,
  retryableTransaction,
  readRecord,
  putRecord,
} from "@/lib/server/database";
import { SafeError } from "@/lib/server/config";
import type { Application } from "@/types";
import type { GmailThreadActivity } from "@/lib/gmail-activity";
import { gmail, official } from "./intake";
import { accessToken } from "./service";

type Cursor = {
  historyId?: string;
  pageToken?: string;
  runId?: string;
  leaseUntil?: number;
};
type MessageRef = { id: string; threadId: string };
type MessageMetadata = MessageRef & {
  internalDate: string;
  labelIds?: string[];
  payload?: { headers?: { name: string; value: string }[] };
};

const addresses = (value: string) =>
  [
    ...value.toLowerCase().matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g),
  ].map((match) => match[0]);

export function matchThreadActivity(
  message: MessageMetadata,
  applications: Application[],
  officialEmail: string,
) {
  if (
    applications.some(
      (application) => application.gmailMessageId === message.id,
    )
  )
    return null;
  const header = (name: string) =>
    message.payload?.headers?.find((item) => item.name.toLowerCase() === name)
      ?.value || "";
  const from = addresses(header("from"));
  const to = addresses(`${header("to")} ${header("cc")}`);
  const officialAddress = officialEmail.toLowerCase();
  const outgoing =
    from.includes(officialAddress) || !!message.labelIds?.includes("SENT");
  const participants = outgoing ? to : from;
  const inReplyTo = header("in-reply-to").trim().toLowerCase();
  const occurredAt = new Date(Number(message.internalDate));
  if (!Number.isFinite(occurredAt.getTime())) return null;
  const candidates = applications
    .filter(
      (item) =>
        !item.deletedAt &&
        !item.isDemo &&
        item.gmailThreadId === message.threadId &&
        participants.includes(item.applicant.email.toLowerCase()) &&
        Date.parse(item.appliedAt) <= occurredAt.getTime(),
    )
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  const application =
    candidates.find((item) => item.rfcMessageId?.toLowerCase() === inReplyTo) ||
    candidates[0];
  if (!application) return null;
  return {
    messageId: message.id,
    applicationId: application.id,
    occurredAt: occurredAt.toISOString(),
    direction: outgoing ? "outgoing" : "incoming",
    subject: header("subject").slice(0, 160),
    threadId: message.threadId,
  } as const;
}

export async function syncGmailThreadActivity() {
  const connection = await official();
  const token = await accessToken(connection);
  const profile = await gmail<{ emailAddress: string; historyId: string }>(
    token,
    "profile",
  );
  if (profile.emailAddress.toLowerCase() !== connection.email.toLowerCase())
    throw new SafeError(
      "The connected account does not match the official mailbox.",
      401,
    );
  if (!profile.historyId)
    throw new SafeError("Gmail history is unavailable.", 502);
  const runId = crypto.randomUUID();
  const cursor = await retryableTransaction(async (tx) => {
    const current =
      (await readRecord<Cursor>(tx, "jobs", "gmail_activity")) || {};
    if (current.leaseUntil && current.leaseUntil > Date.now()) return null;
    const claimed = { ...current, runId, leaseUntil: Date.now() + 90000 };
    await putRecord(tx, "jobs", "gmail_activity", claimed);
    return claimed;
  });
  if (!cursor) return;
  try {
    let messages: MessageRef[] = [];
    let nextPageToken: string | undefined;
    let nextHistoryId: string | undefined;
    const seedRecent = async () => {
      // First run catches recent replies already in Gmail. The history cursor
      // is captured before this scan, so concurrently arriving mail is replayed.
      const head = await gmail<{ messages?: MessageRef[] }>(
        token,
        `messages?maxResults=100&q=${encodeURIComponent("newer_than:7d")}`,
      );
      messages = head.messages || [];
      nextHistoryId = profile.historyId;
    };
    if (!cursor.historyId) {
      await seedRecent();
    } else {
      let response:
        | {
            history?: { messagesAdded?: { message: MessageRef }[] }[];
            nextPageToken?: string;
            historyId: string;
          }
        | undefined;
      try {
        response = await gmail(
          token,
          `history?startHistoryId=${encodeURIComponent(cursor.historyId)}&historyTypes=messageAdded&maxResults=100${cursor.pageToken ? `&pageToken=${encodeURIComponent(cursor.pageToken)}` : ""}`,
        );
      } catch (error) {
        if (!(error instanceof SafeError) || error.status !== 404) throw error;
        // Gmail history cursors expire. Recover recent matching thread mail
        // without resetting the application's original received timestamp.
        await seedRecent();
      }
      if (response) {
        messages = (response.history || []).flatMap((item) =>
          (item.messagesAdded || []).map((added) => added.message),
        );
        nextPageToken = response.nextPageToken;
        nextHistoryId = response.historyId;
      }
    }
    const unique = [
      ...new Map(
        messages.filter((m) => m.id && m.threadId).map((m) => [m.id, m]),
      ).values(),
    ];
    const threadIds = [...new Set(unique.map((m) => m.threadId))];
    const applications = threadIds.length
      ? await readTransaction(async (tx) => {
          const rows = await tx.query(
            `SELECT payload FROM applications WHERE gmail_thread_id IN (${threadIds.map((_, index) => `$${index + 1}`).join(",")})`,
            threadIds,
          );
          return rows.map(
            (row) => JSON.parse(String(row.payload)) as Application,
          );
        })
      : [];
    const relevant = unique.filter((message) =>
      applications.some(
        (application) => application.gmailThreadId === message.threadId,
      ),
    );
    const events: NonNullable<ReturnType<typeof matchThreadActivity>>[] = [];
    for (let i = 0; i < relevant.length; i += 8) {
      const batch = await Promise.all(
        relevant
          .slice(i, i + 8)
          .map((message) =>
            gmail<MessageMetadata>(
              token,
              `messages/${encodeURIComponent(message.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=In-Reply-To`,
            ),
          ),
      );
      for (const message of batch) {
        const event = matchThreadActivity(
          message,
          applications,
          connection.email,
        );
        if (event) events.push(event);
      }
    }
    await retryableTransaction(async (tx) => {
      const current = await readRecord<Cursor>(tx, "jobs", "gmail_activity");
      if (current?.runId !== runId)
        throw new SafeError("A newer Gmail activity scan took over.", 409);
      for (const event of events)
        await tx.query(
          "INSERT INTO gmail_thread_events(message_id,application_id,thread_id,occurred_at,direction,subject) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(message_id) DO NOTHING",
          [
            event.messageId,
            event.applicationId,
            event.threadId,
            event.occurredAt,
            event.direction,
            event.subject,
          ],
        );
      await putRecord(tx, "jobs", "gmail_activity", {
        historyId: nextPageToken ? cursor.historyId : nextHistoryId,
        pageToken: nextPageToken,
        leaseUntil: 0,
      } satisfies Cursor);
    });
  } catch (error) {
    await retryableTransaction(async (tx) => {
      const current = await readRecord<Cursor>(tx, "jobs", "gmail_activity");
      if (current?.runId === runId)
        await putRecord(tx, "jobs", "gmail_activity", {
          ...cursor,
          leaseUntil: 0,
        });
    }).catch(() => {});
    throw error;
  }
}

export async function recentGmailThreadActivity(
  applicationId?: string,
  limit = 5,
) {
  return readTransaction(async (tx): Promise<GmailThreadActivity[]> => {
    const rows = await tx.query(
      `SELECT e.message_id,e.application_id,e.occurred_at,e.direction,e.subject,a.payload
       FROM gmail_thread_events e JOIN applications a ON a.id=e.application_id
       ${applicationId ? "WHERE e.application_id=$1" : ""}
       ORDER BY e.occurred_at DESC,e.message_id DESC LIMIT ${Math.min(50, Math.max(1, limit))}`,
      applicationId ? [applicationId] : [],
    );
    return rows.flatMap((row): GmailThreadActivity[] => {
      const application = JSON.parse(String(row.payload)) as Application;
      if (application.deletedAt || application.isDemo) return [];
      return [
        {
          messageId: String(row.message_id),
          applicationId: String(row.application_id),
          applicantName: application.applicant.name,
          occurredAt: String(row.occurred_at),
          direction: String(row.direction) as GmailThreadActivity["direction"],
          subject: String(row.subject),
        },
      ];
    });
  });
}
