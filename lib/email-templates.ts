import type {
  Application,
  AppState,
  EmailTemplate,
  Stage,
  User,
} from "@/types";
import { formatDate, formatTime } from "./dates";
import { missingInformation } from "./applicant-information";
export const templateVariables = [
  "applicant_name",
  "first_name",
  "position",
  "location",
  "application_id",
  "interview_date",
  "interview_time",
  "hiring_need",
  "company_name",
  "hr_name",
  "next_step",
  "application_date",
];
export function emailContext(a: Application, state: AppState, user: User) {
  const interview =
    [...a.interviews].reverse().find((i) => i.stage === a.stage) ||
    a.interviews.at(-1);
  const need = state.hiringNeeds.find((n) => n.id === a.hiringNeedId);
  return {
    applicant_name: missingInformation(a.applicant.name)
      ? ""
      : a.applicant.name,
    first_name: missingInformation(a.applicant.name)
      ? ""
      : a.applicant.name.split(/\s+/)[0],
    position: missingInformation(a.position) ? "" : a.position,
    location: missingInformation(a.location) ? "" : a.location,
    application_id: a.id,
    interview_date: interview
      ? formatDate(interview.scheduledAt, state.preferences)
      : "",
    interview_time: interview
      ? formatTime(interview.scheduledAt, state.preferences)
      : "",
    hiring_need: need ? `${need.position} — ${need.location}` : "Unassigned",
    company_name: "Daily Joe Careers",
    hr_name: user.name || user.email,
    next_step: a.stage,
    application_date: formatDate(a.appliedAt, state.preferences),
  };
}
export function renderEmail(
  template: Pick<EmailTemplate, "subject" | "body">,
  context: Record<string, string>,
) {
  const missing = new Set<string>();
  const render = (value: string) =>
    value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
      const replacement = context[key.trim()];
      if (!replacement?.trim()) {
        missing.add(key.trim());
        return `{{${key.trim()}}}`;
      }
      return replacement;
    });
  const subject = render(template.subject),
    body = render(template.body);
  if (
    /\{\{|\}\}|\[HR:|\[(?:date|time)\]/i.test(subject + body) &&
    !missing.size
  )
    missing.add("unfinished template instructions");
  return { subject, body, missing: [...missing] };
}
export function workflowTemplate(state: AppState, stage: Stage) {
  return state.emailTemplates.find(
    (t) =>
      t.enabled !== false &&
      (t.stage === stage || (!t.stage && t.name === stage)),
  );
}
export function defaultEmailTemplate(name: string): EmailTemplate {
  const intro = "Hello {{first_name}},\n\n";
  const closing = "\n\nThank you,\n{{hr_name}}\nDaily Joe Careers";
  const bodies: Record<string, string> = {
    "Initial Interview":
      "Thank you for applying for the {{position}} position. We would like to meet you for an initial interview on {{interview_date}} at {{interview_time}}. Your preferred work location is {{location}}. Please reply to confirm your availability; our HR team will provide the meeting arrangements.",
    "Final Interview":
      "Thank you for speaking with our team about the {{position}} role. We would like to invite you to a final interview on {{interview_date}} at {{interview_time}}. Please reply to confirm your availability. We look forward to continuing the conversation.",
    Requirements:
      "Thank you for completing the interviews for {{position}}. Your application has moved to the requirements stage. Our HR team will confirm the required documents and secure submission arrangements with you. Please reply if you have any questions.",
    Onboarding:
      "We look forward to welcoming you to the next step for {{position}}. Your application has moved to onboarding. HR will confirm your orientation schedule and joining arrangements directly with you. Please keep an eye on this email thread for the details.",
    Hired:
      "Welcome to Daily Joe Careers. HR has confirmed the completion of your recruitment process for {{position}}. Please follow the joining arrangements provided by the HR team, and reply here if you need help with your next steps.",
    Rejection:
      "Thank you for your time and interest in the {{position}} position. After reviewing your application, our HR team will not be progressing it on this occasion. We appreciate the opportunity to learn about your experience and wish you well in your search.",
    "Follow-up":
      "We are following up on your application for {{position}} ({{application_id}}). Please reply to let us know whether you would like to continue, or if you have any questions for our HR team.",
    "No Response":
      "We have not yet received your response regarding your {{position}} application. If you remain interested, please reply when you can so we can discuss the next steps. No decision is made automatically because of a missing reply.",
  };
  return {
    id: name,
    name,
    subject: `Daily Joe Careers — ${name}`,
    body: intro + (bodies[name] || bodies["Follow-up"]) + closing,
    ...([
      "Initial Interview",
      "Final Interview",
      "Requirements",
      "Onboarding",
      "Hired",
    ].includes(name)
      ? { stage: name as Stage, enabled: true }
      : {}),
  };
}
