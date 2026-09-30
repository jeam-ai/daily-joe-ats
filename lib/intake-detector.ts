/** Gmail finds candidates; message/document evidence decides intake eligibility. */
export const GMAIL_APPLICATION_QUERY =
  '-in:spam -in:trash -in:sent -in:drafts {has:attachment application applying applicant resume résumé cv "curriculum vitae" "apply for" "interested in working" "mag apply" "mag-apply"}';

export function applicationSearchQuery(query?: string) {
  const value = query?.trim() || "";
  const label = value.replace(/\s+/g, " ").toLowerCase();
  // Replace only the shipped HR label filter; preserve deliberate custom filters.
  if (
    !value ||
    /^label:\s*["']hr\s*-\s*applications["'](?:\s+-in:(?:spam|trash|sent|drafts))*$/.test(
      label,
    )
  )
    return GMAIL_APPLICATION_QUERY;
  return value;
}

export function resumeFilename(filename: string) {
  return /(?:^|[\s_.()-])(?:resume|résumé|cv|curriculum[\s_-]*vitae)(?:[\s_.()-]|$)/i.test(
    filename,
  );
}

type DetectionInput = {
  subject: string;
  body: string;
  filenames: string[];
  headers?: { name: string; value: string }[];
  labelIds?: string[];
  knownThread?: boolean;
  resumeText?: string;
};
export type ApplicationDetection = {
  decision: "application" | "inspect-document" | "ignore";
  reason: string;
};

function submittedText(body: string) {
  // Quoted applications in a follow-up or auto-reply are not new submissions.
  return body
    .split(/\n(?:On .+wrote:|.*Original Message.*|From:\s)/i)[0]
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}
export function detectApplicationEmail(
  input: DetectionInput,
): ApplicationDetection {
  const header = (name: string) =>
    input.headers?.find((h) => h.name.toLowerCase() === name)?.value || "";
  const ignore = (reason: string): ApplicationDetection => ({
    decision: "ignore",
    reason,
  });
  if (
    input.labelIds?.some((id) =>
      ["SPAM", "TRASH", "SENT", "DRAFT"].includes(id),
    )
  )
    return ignore("Message is outside incoming application mail.");
  if (
    (header("auto-submitted") &&
      !/^no$/i.test(header("auto-submitted").trim())) ||
    header("list-id") ||
    /^(?:bulk|list|junk)$/i.test(header("precedence")) ||
    /(?:^|<)(?:no-?reply|mailer-daemon|postmaster)[@+.-]/i.test(header("from"))
  )
    return ignore("Automated, delivery or mailing-list message.");
  const body = submittedText(input.body);
  const text = `${input.subject}\n${body}`;
  const subjectApplication =
    /\b(?:job\s+application|application\s+(?:for|as)|applying\s+(?:for|as)|applicant\s+(?:for|as)|curriculum\s+vitae)\b|^application(?:\s*[-:/]|$)|^(?:resume|résumé|cv)(?:\s|[-:_.]|$)/i.test(
      input.subject.trim(),
    );
  const intent =
    /\b(?:i(?:['’]m|\s+am|\s+would\s+like\s+to|\s+want\s+to)?\s+(?:apply|applying|writing\s+to\s+apply|submit\s+my\s+application|interested\s+in\s+(?:applying|working|the\s+(?:job|position)))|please\s+(?:find|see)\s+(?:my|the)\s+(?:attached\s+)?(?:resume|résumé|cv)|(?:attached|submitting|sending|submit)\s+(?:is\s+)?my\s+(?:resume|résumé|cv)|mag[\s-]*(?:a[\s-]*)?apply|nag[\s-]*a[\s-]*apply|nais\s+(?:ko\s+)?mag[\s-]*apply)\b/i.test(
      body,
    );
  const namedResume = input.filenames.some(resumeFilename);
  const resume = input.resumeText || "";
  const resumeSections = [
    /^\s*(?:education|educational background|academic background)\s*(?::|$)/im,
    /^\s*(?:work experience|professional experience|employment history|work history)\s*(?::|$)/im,
    /^\s*(?:skills|core skills|career objective|personal information)\s*(?::|$)/im,
  ].filter((pattern) => pattern.test(resume)).length;
  const documentResume = resumeSections >= 2;
  if (
    /\b(?:automatic reply|auto[ -]?reply|out of (?:the )?office|undeliverable|delivery (?:status|failure)|job alert|vacancy alert)\b/i.test(
      input.subject,
    )
  )
    return ignore("Notification or automatic reply, not a new application.");
  if (
    (input.knownThread ||
      header("in-reply-to") ||
      /^re\s*:/i.test(input.subject)) &&
    !namedResume &&
    !documentResume &&
    !intent
  )
    return ignore(
      "Existing applicant thread follow-up; retain it as thread activity.",
    );
  if (
    !intent &&
    !namedResume &&
    !documentResume &&
    /\b(?:invoice|receipt|purchase order|payment confirmation|payroll|attendance report|timesheet|bank statement|quotation|newsletter|unsubscribe)\b/i.test(
      text,
    )
  )
    return ignore(
      "Business document or promotional mail without application intent.",
    );
  if (subjectApplication || intent || namedResume || documentResume)
    return {
      decision: "application",
      reason: documentResume
        ? "Resume content contains application evidence."
        : "Application intent or resume submission detected.",
    };
  if (
    input.filenames.some((name) => /\.(?:pdf|docx|txt|png|jpe?g)$/i.test(name))
  )
    return {
      decision: "inspect-document",
      reason: "Unlabelled attachment requires resume-content verification.",
    };
  return ignore("No application intent or resume evidence found.");
}
