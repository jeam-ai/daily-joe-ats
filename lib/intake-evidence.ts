import { formalName } from "./names";
import { senderName } from "./intake-matching";
export interface IntakeEvidence {
  name: string;
  position: string;
  location: string;
  residence: string;
  phone: string;
  education: string;
  availability: string;
  experienceDetails: string;
  evidence: Record<string, string>;
  sources: Record<string, string>;
  nameUncertain: boolean;
  warnings: string[];
}
const roles = ["Team Leader", "Supervisor", "Barista"];
const branches = [
  { name: "Naga City", pattern: /\bnaga(?:\s+city)?\b/i },
  {
    name: "Santa Rosa, Laguna",
    pattern: /\b(?:santa|sta\.?)\s+rosa(?:\s*,?\s*laguna)?\b/i,
  },
];
export function intakeEvidence(input: {
  subject: string;
  body?: string;
  resume?: string;
  filename?: string;
  from?: string;
}): IntakeEvidence {
  const subject = input.subject.slice(0, 500),
    body = input.body || "",
    resume = input.resume || "",
    filename = (input.filename || "").replace(/[_-]/g, " ");
  const intent =
    /(?:apply|applying|application|position|interested|preferred|preference|branch|assigned|willing to (?:work|relocate)|seeking|objective)/i;
  const applicationLines = body
    .split(/[\n.!?]+/)
    .filter((l) => intent.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
  const resumeIntent = resume
    .split(/\n/)
    .filter((l) =>
      /(?:applying for|position applied|desired position|preferred (?:work|branch|location)|seeking (?:a |the )?(?:position|role))/i.test(
        l,
      ),
    );
  const sources = [subject, ...applicationLines, ...resumeIntent, filename];
  const evidence: Record<string, string> = {},
    provenance: Record<string, string> = {},
    warnings: string[] = [];
  const detectedRoles = new Set<string>(),
    detectedLocations = new Set<string>();
  for (const line of sources) {
    // Preserve explicitly submitted roles even when no matching vacancy exists.
    // Employment-history lines never enter these intent sources.
    const explicitRole = line
      .match(
        /\b(?:application for|applying for|position applied(?: for)?\s*[:–-]?|desired position\s*[:–-]?|position\s*:)\s*(?:the\s+)?(.+)/i,
      )?.[1]
      ?.replace(/^job\s*[-:–]\s*/i, "")
      .split(/\s+(?:at|in)\s+|\s+[—–|]\s+|[.!?\n]/i)[0]
      .replace(/\s+(?:position|role)\b.*$/i, "")
      .replace(
        /\s*[-,]?\s*(?:naga(?: city)?|(?:santa|sta\.?) rosa(?:,? laguna)?)\s*$/i,
        "",
      )
      .trim();
    const submittedRole =
      explicitRole &&
      /^[\p{L}][\p{L}\s/&'-]{1,69}$/u.test(explicitRole) &&
      explicitRole.split(/\s+/).length <= 8 &&
      !/\b(?:unspecified|any|vacant|available|opportunity|employment|job|work)\b/i.test(
        explicitRole,
      )
        ? roles.find(
            (role) => role.toLowerCase() === explicitRole.toLowerCase(),
          ) || explicitRole
        : undefined;
    if (submittedRole) {
      detectedRoles.add(submittedRole);
      evidence.position ||= line.slice(0, 300);
      provenance.position ||=
        line === subject
          ? "Email subject"
          : line === filename
            ? "Attachment filename"
            : resumeIntent.includes(line)
              ? "Resume"
              : "Email body";
    }
    for (const role of submittedRole ? [] : roles)
      if (
        new RegExp("\\b" + role.replace(" ", "\\s+") + "\\b", "i").test(line)
      ) {
        detectedRoles.add(role);
        evidence.position ||= line.slice(0, 300);
        provenance.position ||=
          line === subject
            ? "Email subject"
            : line === filename
              ? "Attachment filename"
              : resumeIntent.includes(line)
                ? "Resume"
                : "Email body";
      }
    // Resume/home address lines are excluded. A body line must explicitly refer
    // to applying, a branch, work location, relocation or preference.
    if (
      line === subject ||
      line === filename ||
      /(?:applying|apply|application|branch|preferred|preference|work(?:ing)? (?:in|at)|relocat|assigned)/i.test(
        line,
      )
    )
      for (const branch of branches)
        if (branch.pattern.test(line)) {
          detectedLocations.add(branch.name);
          evidence.location ||= line.slice(0, 300);
          provenance.location ||=
            line === subject
              ? "Email subject"
              : line === filename
                ? "Attachment filename"
                : resumeIntent.includes(line)
                  ? "Resume"
                  : "Email body";
        }
  }
  const named = (text: string) =>
    text
      .match(
        /(?:\bmy name is|\b(?:full\s+)?name\s*:|\b(?:i am|i'm|this is))\s*([\p{L}][\p{L} .,'’-]{2,80}?)(?=\s*(?:,|\.|!|\?|\n|$))/iu,
      )?.[1]
      ?.replace(/\s+(?:po|please)$/i, "")
      .trim();
  const subjectName = subject
    .match(
      /^\s*([\p{L}][\p{L} .,'’-]{3,80}?)\s*[-–—|]\s*(?:resume|cv|curriculum vitae|job application)\b/iu,
    )?.[1]
    ?.trim();
  const headingName = resume
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8)
    .find(
      (l) =>
        /^[\p{L}][\p{L} .,'’-]{4,80}$/u.test(l) &&
        l.split(/\s+/).length >= 2 &&
        l.split(/\s+/).length <= 5 &&
        !/resume|curriculum|vitae|address|contact|profile|personal|information|experience|education|skills|objective|university|college|school|bachelor|barista|cashier|supervisor|leader|street|barangay|camarines|philippines|city|summary|references|career|history|employment|certification|achievement|to obtain|seeking|applying|dear|thank you/i.test(
          l,
        ),
    );
  const explicitResumeName = named(resume);
  const resumeName = explicitResumeName || headingName;
  const submittedName = named(body);
  const normalizeName = formalName;
  const residence =
    (resume + "\n" + body)
      .match(
        /(?:^|\n)\s*(?:(?:home|residential|present|current|permanent)\s+)?address\s*[:–-]\s*([^\n]{5,180})/i,
      )?.[1]
      ?.trim() ||
    resume
      .split(/\n/)
      .slice(0, 25)
      .find((l) =>
        /^\s*(?:zone\s+\d|purok\s+\d|brgy\.?\s|barangay\s|block\s+\d|\d+\s+.{2,50}\b(?:street|st\.|road|rd\.))/i.test(
          l,
        ),
      )
      ?.trim()
      .slice(0, 180) ||
    "Not verified";
  if (residence !== "Not verified") {
    evidence.residence = "Explicit address: " + residence;
    provenance.residence = resume.includes(residence) ? "Resume" : "Email body";
  }
  const displayName = senderName(input.from || "");
  const name = normalizeName(
    resumeName || submittedName || subjectName || displayName,
  );
  if (resumeName) evidence.name = `Resume: ${resumeName}`;
  else if (submittedName) evidence.name = `Email body: ${submittedName}`;
  else if (subjectName) evidence.name = `Email subject: ${subjectName}`;
  else if (
    name !==
    "Applicant name was not clearly stated in the submitted application."
  )
    evidence.name = "Gmail sender display name";
  if (
    resumeName &&
    displayName !==
      "Applicant name was not clearly stated in the submitted application." &&
    normalizeName(resumeName).toLowerCase() !== displayName.toLowerCase()
  )
    warnings.push(
      `Information conflict detected: resume identifies ${name}; email display name is ${displayName}. HR should verify identity.`,
    );
  const text = resume + "\n" + body;
  const phone = text.match(/(?:\+63|0)9\d{2}[ -]?\d{3}[ -]?\d{4}/)?.[0] || "";
  const education = text
    .split(/\n/)
    .filter((l) =>
      /\b(?:bachelor|master|doctorate|high school|senior high|undergraduate|college graduate|degree in)\b/i.test(
        l,
      ),
    )
    .slice(0, 3)
    .join(" · ")
    .slice(0, 600);
  const availability =
    text
      .split(/\n/)
      .find((l) =>
        /\b(?:available for|availability\s*:|willing to work|can work)\b/i.test(
          l,
        ),
      )
      ?.trim()
      .slice(0, 300) || "";
  const experienceDetails =
    text
      .match(
        /(?:work(?:ing)?|employment|professional)\s+(?:experience|history)\s*[:\n]([\s\S]{0,800}?)(?=\n(?:education|skills|references|certifications)\b|$)/i,
      )?.[1]
      ?.trim()
      .slice(0, 600) || "";
  for (const [key, value] of Object.entries({
    phone,
    education,
    availability,
    experienceDetails,
  }))
    if (value) {
      evidence[key] = value;
      provenance[key] = value
        .split(" · ")
        .every((part) => resume.includes(part))
        ? "Resume"
        : "Submitted resume / email";
    }
  if (detectedRoles.size > 1)
    warnings.push("Conflicting applied positions require HR verification.");
  if (detectedLocations.size > 1)
    warnings.push("Multiple preferred branches require HR verification.");
  return {
    name,
    residence,
    phone,
    education,
    availability,
    experienceDetails,
    position:
      detectedRoles.size === 1
        ? [...detectedRoles][0]
        : "Applied position was not clearly stated in the submitted application.",
    location:
      detectedLocations.size === 1
        ? [...detectedLocations][0]
        : "Preferred work location was not clearly stated in the submitted application.",
    evidence,
    sources: provenance,
    nameUncertain:
      (!explicitResumeName && !submittedName && !subjectName) ||
      (!!headingName && !explicitResumeName),
    warnings,
  };
}
export function messageBody(part: {
  mimeType?: string;
  body?: { data?: string };
  parts?: unknown[];
}): string {
  const flat = (p: typeof part): (typeof part)[] => [
    p,
    ...(p.parts || []).flatMap((v) => flat(v as typeof part)),
  ];
  const all = flat(part),
    plain = all.filter((p) => p.mimeType === "text/plain" && p.body?.data);
  const selected = plain.length
    ? plain
    : all.filter((p) => p.mimeType === "text/html" && p.body?.data);
  return selected
    .map((p) =>
      Buffer.from(p.body!.data!, "base64url")
        .toString("utf8")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&"),
    )
    .join("\n")
    .slice(0, 20000);
}
