import { formalName, plausiblePersonName } from "./names";
import { formalFact } from "./formal-facts";
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
  skills: string;
  certifications: string;
  evidence: Record<string, string>;
  sources: Record<string, string>;
  nameUncertain: boolean;
  warnings: string[];
}
const defaultRoles = ["Team Leader", "Supervisor", "Barista"];
const defaultBranches = [
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
  positions?: string[];
  locations?: string[];
}): IntakeEvidence {
  const subject = input.subject.slice(0, 500),
    body = input.body || "",
    resume = input.resume || "",
    filename = (input.filename || "").replace(/[_-]/g, " ");
  const roles = [...new Set([...defaultRoles, ...(input.positions || [])])]
    .filter((role) => role && role !== "Other")
    .sort((a, b) => b.length - a.length);
  const branches = [
    ...defaultBranches,
    ...(input.locations || [])
      .filter(
        (name) =>
          name &&
          name !== "Other" &&
          !defaultBranches.some((branch) => branch.name === name),
      )
      .map((name) => ({
        name,
        pattern: new RegExp(
          `(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`,
          "iu",
        ),
      })),
  ];
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
      .split(/\s+(?:at|in)\s+|\s+[-—–|]\s+|[.!?\n]/i)[0]
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
        new RegExp(
          "\\b" +
            role
              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              .replace(/\s+/g, "\\s+") +
            "\\b",
          "i",
        ).test(line)
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
        break;
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
  const named = (text: string) => {
    const candidate = (
      text.match(
        /(?:^|\n)\s*(?:full\s+)?name\s*[:–-]\s*([^\n]{2,100})/iu,
      )?.[1] ||
      text.match(
        /(?:\bmy name is|\b(?:i am|i'm|this is))\s*([\p{L}][\p{L} .,'’-]{2,80}?)(?=\s*(?:,|\.|!|\?|\n|$))/iu,
      )?.[1]
    )
      ?.replace(/\s+(?:po|please)$/i, "")
      .replace(/[.!?]+$/, "")
      .trim();
    if (
      !candidate ||
      !plausiblePersonName(candidate) ||
      /^(?:a|an|my|writing|applying|interested|seeking|looking|excited|available|hoping|reaching|contacting|submitting|sending)\b/i.test(
        candidate,
      ) ||
      /\b(?:application|interest|job|post|position|opportunity)\b/i.test(
        candidate,
      )
    )
      return undefined;
    return candidate;
  };
  const subjectName = subject
    .match(
      /^\s*([\p{L}][\p{L} .,'’-]{3,80}?)\s*[-–—|]\s*(?:resume|cv|curriculum vitae|job application)\b/iu,
    )?.[1]
    ?.trim();
  const headingLines = resume
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const firstSection = headingLines.findIndex((line) =>
    /^(?:contact|education|skills|experience|work experience|objective|objectives|profile|summary|about me)\s*(?::.*)?$/i.test(
      line,
    ),
  );
  const headingName = headingLines
    .slice(0, firstSection < 0 ? 8 : firstSection)
    .slice(0, 8)
    .find(
      (l) =>
        /^[\p{L}][\p{L} .,'’-]{4,80}$/u.test(l) &&
        l.split(/\s+/).length >= 2 &&
        l.split(/\s+/).length <= 5 &&
        !/resume|curriculum|vitae|address|contact|profile|personal|information|experience|education|skills|objective|university|college|school|bachelor|barista|cashier|supervisor|leader|accounting|analyst|manager|staff|assistant|engineer|developer|administrator|intern|clerk|officer|executive|representative|specialist|recruitment|human resources|street|barangay|camarines|philippines|city|summary|references|career|history|employment|certification|achievement|to obtain|seeking|applying|dear|thank you/i.test(
          l,
        ),
    );
  const explicitResumeName = named(resume);
  const resumeName = explicitResumeName || headingName;
  const submittedName = named(body);
  const filenameName = input.filename
    ?.replace(/\.(?:pdf|docx|png|jpe?g|txt)$/i, "")
    .match(
      /^\s*([\p{L}][\p{L} .,'’-]{3,80}?)\s*[-–—]\s*(?:pdf\s*)?(?:resume|cv)\s*$/iu,
    )?.[1]
    ?.trim();
  const safeFilenameName =
    filenameName && plausiblePersonName(filenameName) ? filenameName : "";
  const normalizeName = formalName;
  const resumeLines = resume
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const contactIndex = resumeLines.findIndex((line) =>
    /^(?:contact|contact information|contact details)\s*:?$/i.test(line),
  );
  const contactLines =
    contactIndex < 0
      ? []
      : resumeLines.slice(contactIndex + 1, contactIndex + 13);
  const addressPattern = /^[\p{L}\d .'-]+,\s*[\p{L} .'-]+,\s*[\p{L} .'-]+$/u;
  const joinedLine = (lines: string[], index: number) =>
    lines[index].endsWith(",")
      ? `${lines[index]} ${lines[index + 1] || ""}`
      : lines[index];
  const addressIsSafe = (line: string) =>
    addressPattern.test(line) &&
    !/@|(?:school|university|college|company|office)/i.test(line);
  const contactAddress =
    contactLines
      .map((line, index) => joinedLine(contactLines, index))
      .find(addressIsSafe) ||
    resumeLines
      .slice(0, 60)
      .map((_, index) => ({
        line: joinedLine(resumeLines, index),
        nearby: resumeLines.slice(Math.max(0, index - 4), index + 5).join(" "),
      }))
      .find(
        (candidate) =>
          addressIsSafe(candidate.line) &&
          /@|(?:\+63|0)9\d{2}/.test(candidate.nearby),
      )?.line;
  const addressMatch = (resume + "\n" + body).match(
    /(?:^|\n)\s*(?:(?:home|residential|present|current|permanent)\s+)?address\s*[:–-]\s*([^\n]{5,180})(?:\n([^\n]{2,90}))?/i,
  );
  const addressFirst = addressMatch?.[1]?.trim() || "";
  const addressNext = addressMatch?.[2]?.trim() || "";
  const labeledAddress =
    addressFirst.endsWith(",") &&
    /^[\p{L}][\p{L}\s,.'-]{2,88}$/u.test(addressNext) &&
    !/^(?:contact|phone|email|e-mail|skills?|education|experience)\b/i.test(
      addressNext,
    )
      ? `${addressFirst} ${addressNext}`
      : addressFirst;
  const residence =
    labeledAddress ||
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
    contactAddress ||
    "Not verified";
  if (residence !== "Not verified") {
    evidence.residence = "Explicit address: " + residence;
    provenance.residence = resume
      .replace(/\s+/g, " ")
      .includes(residence.replace(/\s+/g, " "))
      ? "Resume"
      : "Email body";
  }
  const displayName = senderName(input.from || "");
  const name = normalizeName(
    resumeName ||
      submittedName ||
      subjectName ||
      safeFilenameName ||
      displayName,
  );
  if (resumeName) evidence.name = `Resume: ${resumeName}`;
  else if (submittedName) evidence.name = `Email body: ${submittedName}`;
  else if (subjectName) evidence.name = `Email subject: ${subjectName}`;
  else if (safeFilenameName)
    evidence.name = `Attachment filename: ${safeFilenameName}`;
  else if (
    name !==
    "Applicant name was not clearly stated in the submitted application."
  )
    evidence.name = "Gmail sender display name";
  if (
    resumeName &&
    displayName !==
      "Applicant name was not clearly stated in the submitted application." &&
    plausiblePersonName(displayName) &&
    normalizeName(resumeName).toLowerCase() !== displayName.toLowerCase()
  )
    warnings.push(
      `Information conflict detected: resume identifies ${name}; email display name is ${displayName}. HR should verify identity.`,
    );
  const text = resume + "\n" + body;
  const phone = text.match(/(?:\+63|0)9\d{2}[ -]?\d{3}[ -]?\d{4}/)?.[0] || "";
  const sectionLines = (heading: RegExp, limit: number) => {
    const lines = resume.split(/\n/).map((line) => line.trim());
    const start = lines.findIndex((line) => heading.test(line));
    if (start < 0) return [];
    const found: string[] = [];
    const inline = lines[start].split(":").slice(1).join(":").trim();
    if (inline) found.push(inline);
    for (const line of lines.slice(start + 1)) {
      if (
        /^(?:contact|education|skills?(?:\s+(?:and|&)\s+competenc(?:y|ies))?|certifications?|job experience|work experience|employment history|professional experience|work history|references|about me|objectives?|profile|summary)\s*(?::.*)?$/i.test(
          line,
        )
      )
        break;
      if (!line || /^[-–•]?\s*$/.test(line)) continue;
      found.push(line.replace(/^[-–•]\s*/, ""));
      if (found.length >= limit) break;
    }
    return found;
  };
  const educationLines = sectionLines(/^education\s*(?::.*)?$/i, 7);
  const education = [
    ...new Set([
      ...educationLines.filter((line) =>
        /\b(?:bachelor|master|doctorate|high school|senior high|undergraduate|college|university|degree|academic strand|honor|graduate|[12]\d{3})\b/i.test(
          line,
        ),
      ),
      ...text
        .split(/\n/)
        .filter((line) =>
          /\b(?:bachelor|master|doctorate|high school|senior high|undergraduate|college graduate|degree in)\b/i.test(
            line,
          ),
        ),
    ]),
  ]
    .slice(0, 5)
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
  const experienceLines = sectionLines(
    /^(?:job experience|work experience|employment history|professional experience|work history)\s*(?::.*)?$/i,
    7,
  );
  const experienceDetails =
    (experienceLines.length
      ? experienceLines.join(" · ")
      : text.match(
          /(?:job|work(?:ing)?|employment|professional)\s+(?:experience|history)\s*[:\n]([\s\S]{0,800}?)(?=\n(?:education|skills|references|certifications)\b|$)/i,
        )?.[1] || ""
    )
      .trim()
      .slice(0, 600) || "";
  const skills = sectionLines(
    /^skills?(?:\s+(?:and|&)\s+competenc(?:y|ies))?\s*(?::.*)?$/i,
    12,
  )
    .join("\n")
    .slice(0, 600);
  const certifications = sectionLines(/^certifications?\s*(?::.*)?$/i, 6)
    .join("\n")
    .slice(0, 600);
  for (const [key, value] of Object.entries({
    phone,
    education,
    availability,
    experienceDetails,
    skills,
    certifications,
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
    residence: formalFact("residence", residence),
    phone,
    education: formalFact("education", education),
    availability: formalFact("availability", availability),
    experienceDetails: formalFact("experienceDetails", experienceDetails),
    skills: formalFact("skills", skills),
    certifications: formalFact("certifications", certifications),
    position:
      detectedRoles.size === 1
        ? formalFact("position", [...detectedRoles][0])
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
