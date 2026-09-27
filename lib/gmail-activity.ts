export type GmailThreadActivity = {
  messageId: string;
  applicationId: string;
  applicantName: string;
  occurredAt: string;
  direction: "incoming" | "outgoing";
  subject: string;
};

export function activityLabel(direction: GmailThreadActivity["direction"]) {
  return direction === "incoming"
    ? "Applicant replied"
    : "Email sent from Careers Gmail";
}
