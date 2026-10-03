import { formalName, plausiblePersonName } from "./names";
import { formalFact } from "./formal-facts";
import { senderName } from "./intake-matching";
import { canonicalLocationName, nearbyConfiguredBranch } from "./locations";
import type { Location } from "@/types";
export interface IntakeEvidence {
  name: string;
  email?: string;
  position: string;
  location: string;
  residence: string;
  /** A configured branch matched directly in the submitted home address. */
  residenceLocation: string;
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
  {
    name: "General Trias",
    pattern: /\b(?:general\s+trias|gen\.?\s*tri(?:as)?)\b/i,
  },
];
const certificationHeading =
  /^(?:(?:professional\s+)?certifications?|certificates?(?:\s*(?:\/|&|and)\s*trainings?)?|trainings?(?:\s+(?:attended|completed))?(?:\s*(?:\/|&|and)\s*certificates?)?|licenses?|credentials?|seminars?(?:\s*(?:\/|&|and)\s*trainings?)?)\s*(?::.*)?$/i;
const credentialLine =
  /\b(?:certifications?|certificates?|trainings?(?:\s+sessions?)?|licenses?|credentials?|tesda|national\s+certificate|nc\s*(?:i|ii|iii|iv|v|2|3|4)|servsafe|food\s+safety|first\s+aid|bosh|cosh)\b/i;
const skillsHeading =
  /^(?:(?:core|key|technical|professional|personal)\s+)?(?:skills?(?:\s+(?:and|&|\/)\s+competenc(?:y|ies))?|competenc(?:y|ies)|strengths?|expertise|abilities|personal\s+attributes?)\s*(?::.*)?$/i;
const qualificationsHeading =
  /^(?:(?:key|core|minimum|preferred|professional)\s+)?qualifications?\s*(?::.*)?$/i;
const experienceHeading =
  /^(?:experience|relevant experience|job experience|work experience|employment(?: history)?|professional experience|work history|career history|work background|career summary)\s*(?::.*)?$/i;
const educationHeading =
  /^(?:education(?:al(?: background| attainment)?)?|academic background|academic qualifications?)\s*(?::.*)?$/i;
const contactHeading =
  /^(?:contact(?:\s+(?:information|details))?|personal information|personal details)\s*:?$/i;
const phonePattern =
  /(?:\+?63\s*[-()]?\s*|0)(?:9\d{2})\s*[-()]?\s*\d{3}\s*[-()]?\s*\d{4}\b|(?:\(?02\)?|0?2)\s*[-()]?\s*\d{4}\s*[-()]?\s*\d{4}\b/;
const availabilityPattern =
  /(?:available\s+(?:for|to start|on)|availability\s*[:\-]|willing\s+to\s+work|can\s+work|immediately\s+available|available\s+immediately|can\s+start|start\s+(?:immediately|asap)|open\s+availability|flexible\s+(?:schedule|hours)|(?:weekday|weekend|shift)\s+availability)/i;
const fieldSeparator = "[:|–—-]";
const sectionBoundary =
  /^(?:contact(?:\s+(?:information|details))?|personal (?:information|details)|education(?:al(?: background| attainment)?)?|academic background|academic qualifications?|skills?(?:\s+(?:and|&|\/|and)\s+competenc(?:y|ies))?|(?:core|key|technical|professional|personal)\s+(?:skills?|strengths?|competenc(?:y|ies)|qualifications?)|competenc(?:y|ies)|strengths?|expertise|qualifications?|personal\s+attributes?|certifications?|certificates?|licenses?|credentials?|experience|relevant experience|job experience|work experience|employment(?: history)?|professional experience|work history|career history|work background|career summary|references|about me|objectives?|profile|summary)\s*(?::.*)?$/i;
const cleanOcrName = (value: string) =>
  value
    .replace(/\b\p{Lu}*0\p{Lu}*\b/gu, (word) => word.replaceAll("0", "O"))
    .replace(/(\p{L})0(?=\p{L}|\b)/gu, "$1o");
const genericProfileName = (value: string) =>
  /\b(?:place\s+of\s+birth|date\s+of\s+birth|civil\s+status|marital\s+status|nationality|gender|\bsingle\b)\b/i.test(
    value,
  );
const safeResumeHeaderName = (value: string) => {
  const cleaned = cleanOcrName(value)
    .replace(/^\s*(?:name|full name)\s*[:|–—-]\s*/i, "")
    .trim();
  return cleaned &&
    plausiblePersonName(cleaned) &&
    !genericProfileName(cleaned) &&
    !/\b(?:resume|curriculum|vitae|address|contact|profile|personal|information|experience|education|skills|objective|university|college|school|bachelor|barista|cashier|supervisor|leader|accounting|analyst|manager|staff|assistant|engineer|developer|administrator|intern|clerk|officer|executive|representative|specialist|recruitment|human resources|street|barangay|camarines|philippines|city|summary|references|career|history|employment|certification|achievement|to obtain|seeking|applying|dear|thank you|place of birth|single)\b/i.test(
      cleaned,
    )
    ? cleaned
    : "";
};
export function intakeEvidence(input: {
  subject: string;
  body?: string;
  resume?: string;
  filename?: string;
  from?: string;
  positions?: string[];
  locations?: string[];
  /** Active configured locations provide city-level nearby branch matching. */
  locationDetails?: Pick<Location, "name" | "city" | "province" | "active">[];
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
      .map(canonicalLocationName)
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
    /(?:apply|applying|application|position|role|job|interested|preferred|preference|branch|location|work site|workplace|assigned|willing to (?:work|relocate)|seeking|objective)/i;
  const applicationLines = body
    .split(/[\n.!?]+/)
    .filter((l) => intent.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
  const resumeIntent = resume
    .split(/\n/)
    .filter((l) =>
      /(?:application for|applying (?:for|as)|position applied(?: for)?|role applied(?: for)?|job applied(?: for)?|(?:position|role|job title)\s*[:–-]|desired (?:position|role)|target (?:position|role)|preferred (?:work|branch|location|area)|seeking (?:a |the )?(?:position|role)|work(?:place| site) preference)/i.test(
        l,
      ),
    );
  // Deterministic extraction always reads the submitted resume first. Email
  // body and subject only fill a field when that evidence is absent there.
  const sources = [
    ...resumeIntent.map((line) => ({ line, source: "Resume" })),
    ...applicationLines.map((line) => ({ line, source: "Email body" })),
    { line: subject, source: "Email subject" },
    { line: filename, source: "Attachment filename" },
  ];
  const evidence: Record<string, string> = {},
    provenance: Record<string, string> = {},
    warnings: string[] = [];
  const detectedRoles = new Set<string>(),
    detectedLocations = new Set<string>();
  let positionSource = "",
    locationSource = "";
  for (const { line, source } of sources) {
    // Preserve explicitly submitted roles even when no matching vacancy exists.
    // Employment-history lines never enter these intent sources.
    const rawExplicitRole = line
      .match(
        /\b(?:application for|applying (?:for|as)|position applied(?: for)?\s*[:|–-]?|role applied(?: for)?\s*[:|–-]?|job applied(?: for)?\s*[:|–-]?|desired (?:position|role)\s*[:|–-]?|target (?:position|role)\s*[:|–-]?|(?:position|role|job title)\s*[:|])\s*(?:the\s+)?(.+)/i,
      )?.[1]
      ?.replace(/^job\s*[-:–]\s*/i, "")
      .split(/\s+(?:at|in)\s+|\s+[-—–|]\s+|[.!?\n]/i)[0]
      .replace(/\s+(?:position|role)\b.*$/i, "")
      .replace(
        /\s*[-,]?\s*(?:naga(?: city)?|(?:santa|sta\.?) rosa(?:,? laguna)?)\s*$/i,
        "",
      )
      .trim();
    let explicitRole = rawExplicitRole;
    for (const branch of branches) {
      const match = branch.pattern.exec(explicitRole || "");
      if (match && match.index + match[0].length === explicitRole?.length)
        explicitRole = explicitRole
          ?.slice(0, match.index)
          .replace(/(?:\b(?:at|in|for|branch)\b|[-—–|,:])\s*$/i, "")
          .trim();
    }
    const submittedRole =
      explicitRole &&
      /^[\p{L}][\p{L}\s/&'-]{1,69}$/u.test(explicitRole) &&
      explicitRole.split(/\s+/).length <= 8 &&
      !/\b(?:this|these|that|opening|vacancy|unspecified|any|vacant|available|opportunity|employment|job|work)\b/i.test(
        explicitRole,
      )
        ? roles.find(
            (role) => role.toLowerCase() === explicitRole.toLowerCase(),
          ) || explicitRole
        : undefined;
    if (submittedRole && (!positionSource || positionSource === source)) {
      positionSource ||= source;
      detectedRoles.add(submittedRole);
      evidence.position ||= line.slice(0, 300);
      provenance.position ||= source;
    }
    for (const role of submittedRole ? [] : roles)
      if (
        (!positionSource || positionSource === source) &&
        new RegExp(
          "\\b" +
            role
              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              .replace(/\s+/g, "\\s+") +
            "\\b",
          "i",
        ).test(line)
      ) {
        positionSource ||= source;
        detectedRoles.add(role);
        evidence.position ||= line.slice(0, 300);
        provenance.position ||= source;
        break;
      }
    // Resume/home address lines are excluded. A body line must explicitly refer
    // to applying, a branch, work location, relocation or preference.
    if (
      line === subject ||
      line === filename ||
      /(?:applying|apply|application|branch|preferred|preference|work(?:ing)? (?:in|at)|work(?:place| site)|location|relocat|assigned)/i.test(
        line,
      )
    )
      for (const branch of branches)
        if (
          (!locationSource || locationSource === source) &&
          branch.pattern.test(line)
        ) {
          locationSource ||= source;
          detectedLocations.add(branch.name);
          evidence.location ||= line.slice(0, 300);
          provenance.location ||= source;
        }
  }
  const named = (text: string) => {
    const candidate = (
      text.match(
        new RegExp(
          `(?:^|\\n)\\s*(?:(?:full|applicant|candidate)\\s+)?name\\s*${fieldSeparator}\\s*([^\\n]{2,100})`,
          "iu",
        ),
      )?.[1] ||
      text.match(
        /(?:\bmy name is|\b(?:i am|i'm|this is))\s*([\p{L}][\p{L} .,'’-]{2,80}?)(?=\s*(?:,|\.|!|\?|\n|$))/iu,
      )?.[1]
    )
      ?.replace(/\s+(?:po|please)$/i, "")
      .replace(/[.!?]+$/, "")
      .trim();
    const cleaned = candidate ? cleanOcrName(candidate) : undefined;
    if (
      !cleaned ||
      !plausiblePersonName(cleaned) ||
      genericProfileName(cleaned) ||
      /^(?:a|an|my|writing|applying|interested|seeking|looking|excited|available|hoping|reaching|contacting|submitting|sending)\b/i.test(
        cleaned,
      ) ||
      /\b(?:application|interest|job|post|position|opportunity)\b/i.test(
        cleaned,
      )
    )
      return undefined;
    return cleaned;
  };
  const subjectCandidate = subject
    .match(
      /^\s*([\p{L}][\p{L} .,'’-]{3,80}?)\s*[-–—|]\s*(?:resume|cv|curriculum vitae|job application)\b/iu,
    )?.[1]
    ?.trim();
  const subjectName =
    subjectCandidate &&
    !!safeResumeHeaderName(subjectCandidate) &&
    !genericProfileName(subjectCandidate)
      ? subjectCandidate
      : undefined;
  const headingLines = resume
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const firstSection = headingLines.findIndex(
    (line) =>
      certificationHeading.test(line) ||
      /^(?:contact|personal (?:information|details)|education(?:al(?: background| attainment)?)?|academic background|skills?(?:\s+(?:and|&)\s+competenc(?:y|ies))?|experience|relevant experience|work experience|employment|objective|objectives|profile|summary|about me)\s*(?::.*)?$/i.test(
        line,
      ),
  );
  const headingName = headingLines
    .slice(0, firstSection < 0 ? 8 : firstSection)
    .slice(0, 8)
    .map(cleanOcrName)
    .find(
      (l) =>
        /^[\p{L}][\p{L} .,'’-]{4,80}$/u.test(l) && !!safeResumeHeaderName(l),
    );
  // Some PDF/DOCX extractors flatten the resume header onto one line. Recover
  // only the leading name before a phone, email, label, or visual separator;
  // this remains deliberately conservative so prose is never treated as a name.
  const resumeOpening = resume.replace(/\r/g, "").slice(0, 420);
  const inlineHeaderName = [
    resumeOpening.split(/\n|[|•·]/)[0],
    resumeOpening.split(
      /\b(?:email|e-mail|mobile|phone|contact(?:\s+(?:number|details))?|address)\b/i,
    )[0],
    resumeOpening.split(phonePattern)[0],
    resumeOpening.split(/[^\s@]+@[^\s@]+\.[^\s@]+/i)[0],
  ]
    .map((candidate) => candidate?.replace(/[|•·]+$/g, "").trim() || "")
    .map(safeResumeHeaderName)
    .find(Boolean);
  const explicitResumeName = named(resume);
  const resumeName = explicitResumeName || headingName || inlineHeaderName;
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
    contactHeading.test(line),
  );
  const contactLines =
    contactIndex < 0
      ? []
      : resumeLines.slice(contactIndex + 1, contactIndex + 13);
  const addressPattern = /^[\p{L}\d .'-]+,\s*[\p{L} .'-]+,\s*[\p{L} .'-]+$/u;
  const addressCue =
    /\b(?:blk\.?|block|lot|house|unit|purok|zone|sitio|brgy\.?|barangay|subd\.?|subdivision|street|st\.?|road|rd\.?|avenue|ave\.?)\b/i;
  const localityCue =
    /\b(?:city|municipality|province|cavite|laguna|camarines|masbate|philippines|[a-z][a-z .'-]+\s+(?:subd\.?|barangay|brgy\.?))\b/i;
  const joinedLine = (lines: string[], index: number) =>
    lines[index].endsWith(",")
      ? `${lines[index]} ${lines[index + 1] || ""}`
      : lines[index];
  const addressIsSafe = (line: string) =>
    (addressPattern.test(line) ||
      (addressCue.test(line) && localityCue.test(line))) &&
    !/@|(?:school|university|college|company|office|career\s+objective|profile|experience|skills?|processed\s+(?:cash|card|digital)|customer\s+service)/i.test(
      line,
    );
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
  const labeledAddressMatch = [
    { text: resume, source: "Resume" },
    { text: body, source: "Email body" },
  ]
    .filter((document) => document.text.trim())
    .map((document) => ({
      ...document,
      match: document.text.match(
        new RegExp(
          `(?:^|\\n)\\s*(?:(?:home|residential|present|current|permanent)\\s+)?(?:address|residence)\\s*${fieldSeparator}\\s*([^\\n]{5,180})(?:\\n([^\\n]{2,90}))?`,
          "i",
        ),
      ),
    }))
    .find((document) => document.match);
  const addressMatch = labeledAddressMatch?.match;
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
    body
      .match(
        /\b(?:i\s+(?:live|reside|am\s+currently\s+living)\s+in|my\s+(?:home|residence)\s+is)\s+([^\n.!?]{5,180})/i,
      )?.[1]
      ?.trim()
      .replace(/[,.]+$/, "") ||
    "Not verified";
  if (residence !== "Not verified") {
    evidence.residence = "Explicit address: " + residence;
    provenance.residence =
      labeledAddressMatch?.source ||
      (resume.replace(/\s+/g, " ").includes(residence.replace(/\s+/g, " "))
        ? "Resume"
        : "Email body");
  }
  // A home address is not an asserted work preference. It can, however,
  // safely pre-fill the separate assigned-branch field when it contains one
  // and only one currently configured location. This never overwrites an HR
  // assignment and keeps the preferred-location field evidence-pure.
  const configuredResidenceLocations = input.locationDetails?.length
    ? input.locationDetails
        .filter((location) => location.active && location.name !== "Other")
        .map((location) => ({
          ...location,
          name: canonicalLocationName(location.name),
        }))
    : [...new Set((input.locations || []).map(canonicalLocationName))]
        .filter((name) => name && name !== "Other")
        .map((name) => ({ name, city: "", province: "", active: true }));
  const residenceLocation = nearbyConfiguredBranch(
    residence,
    configuredResidenceLocations,
  );
  if (residenceLocation) {
    evidence.assignedBranch = `Residence matched configured location: ${residenceLocation}.`;
    provenance.assignedBranch = "Residence match";
    // The recruiting policy treats one exact configured residence match as a
    // usable branch preference when the applicant did not state another one.
    // An explicit preferred branch above always wins over this fallback.
    if (!detectedLocations.size) {
      detectedLocations.add(residenceLocation);
      evidence.location = `Residence matched configured location: ${residenceLocation}.`;
      provenance.location = "Residence match";
    }
  }
  const displayName = senderName(input.from || "");
  const validDisplayName =
    !!safeResumeHeaderName(displayName) &&
    !/\b(?:recruitment|careers|human resources|daily joe|hr team)\b/i.test(
      displayName,
    );
  const senderEmail = (input.from || "")
    .match(/<([^<>\s]+@[^<>\s]+)>|\b([^\s<>]+@[^\s<>]+\.[^\s<>]+)\b/i)
    ?.slice(1)
    .find(Boolean)
    ?.toLowerCase();
  const emailPattern =
    /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/i;
  // Restrict resume email recovery to its header/contact area so reference
  // contacts later in the document cannot become the applicant's address.
  const resumeContact = resume
    .split(
      /\b(?:references|work experience|employment history|education)\b/i,
    )[0]
    .slice(0, 1500);
  const resumeEmail = resumeContact.match(emailPattern)?.[0]?.toLowerCase();
  const bodyEmail = body
    .match(
      /(?:^|\n)\s*(?:email|e-mail|email address)\s*[:–—-]\s*([^\s<>]+)/i,
    )?.[1]
    ?.match(emailPattern)?.[0]
    ?.toLowerCase();
  const email = resumeEmail || bodyEmail || senderEmail || "";
  if (email) {
    evidence.email = `${resumeEmail ? "Resume" : bodyEmail ? "Email body" : "Gmail sender"}: ${email}`;
    provenance.email = resumeEmail
      ? "Resume"
      : bodyEmail
        ? "Email body"
        : "Gmail sender";
  }
  const name = normalizeName(
    resumeName ||
      submittedName ||
      safeFilenameName ||
      (validDisplayName ? displayName : "") ||
      subjectName ||
      "Applicant name was not clearly stated in the submitted application.",
  );
  if (resumeName) evidence.name = `Resume: ${resumeName}`;
  else if (submittedName) evidence.name = `Email body: ${submittedName}`;
  else if (safeFilenameName)
    evidence.name = `Attachment filename: ${safeFilenameName}`;
  else if (validDisplayName) evidence.name = "Gmail sender display name";
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
    validDisplayName &&
    normalizeName(resumeName).toLowerCase() !== displayName.toLowerCase()
  )
    warnings.push(
      `Information conflict detected: resume identifies ${name}; email display name is ${displayName}. HR should verify identity.`,
    );
  const documents = [
    { text: resume, source: "Resume" },
    { text: body, source: "Email body" },
    { text: subject, source: "Email subject" },
  ].filter((document) => document.text.trim());
  const firstMatch = (pattern: RegExp) =>
    documents
      .map((document) => ({
        source: document.source,
        value: document.text.match(pattern)?.[0] || "",
      }))
      .find((match) => match.value);
  const sectionLines = (text: string, heading: RegExp, limit: number) => {
    const lines = text.split(/\n/).map((line) => line.trim());
    const start = lines.findIndex((line) => heading.test(line));
    if (start < 0) return [];
    const found: string[] = [];
    const inline = lines[start]
      .split(new RegExp(fieldSeparator))
      .slice(1)
      .join(" ")
      .trim();
    if (inline) found.push(inline);
    for (const line of lines.slice(start + 1)) {
      if (sectionBoundary.test(line)) break;
      if (!line || /^[-–•]?\s*$/.test(line)) continue;
      found.push(line.replace(/^[-–•]\s*/, ""));
      if (found.length >= limit) break;
    }
    return found;
  };
  const section = (heading: RegExp, limit: number) => {
    for (const document of documents) {
      const values = sectionLines(document.text, heading, limit);
      if (values.length) return { values, source: document.source };
    }
    return { values: [] as string[], source: "" };
  };
  const educationTerms =
    /\b(?:bachelor|master|doctorate|associate(?:['’]s)?|high school|senior high|junior high|secondary school|college|university|degree|academic strand|honou?rs?|graduate|diploma|vocational|tesda|tvl|stem|abm|humss|bs(?:[a-z.]|\s)|ba(?:[a-z.]|\s)|[12]\d{3})\b/i;
  const educationSection = section(educationHeading, 10);
  const educationLevelHeading =
    /^(?:tertiary|secondary|primary|elementary|college|university|senior\s+high(?:\s+school)?|junior\s+high(?:\s+school)?)\s*:?$/i;
  const educationPeriod =
    /\b(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|present)\b/i;
  const educationTimeline = documents
    .map((document) => {
      const lines = document.text
        .split(/\n/)
        .map((line) => line.trim().replace(/^[-–•]\s*/, ""))
        .filter(Boolean);
      const start = lines.findIndex(
        (line) =>
          educationHeading.test(line) || educationLevelHeading.test(line),
      );
      if (start < 0) return { values: [] as string[], source: document.source };
      const values: string[] = [];
      let beforePeriod: string[] = [];
      const institution =
        /\b(?:university|college|school|academy|lyceum|polytechnic|institute|technical)\b/i;
      const degree =
        /\b(?:bachelor|master|doctorate|associate|high\s+school|senior\s+high|junior\s+high|secondary|elementary|diploma|academic\s+strand|stem|abm|humss|tvl|bs(?:[a-z.]|\s)|ba(?:[a-z.]|\s))\b/i;
      for (let index = start + 1; index < lines.length; index++) {
        const line = lines[index];
        if (sectionBoundary.test(line)) break;
        if (educationLevelHeading.test(line) || !line) continue;
        if (educationPeriod.test(line)) {
          const after: string[] = [];
          for (const next of lines.slice(index + 1, index + 4)) {
            if (sectionBoundary.test(next) || educationPeriod.test(next)) break;
            if (institution.test(next) && after.length) break;
            if (degree.test(next)) after.push(next);
            else if (
              !after.length &&
              /\b(?:major|strand|speciali[sz]ation)\b/i.test(next)
            )
              after.push(next);
          }
          const details = [...new Set([...beforePeriod, ...after])].filter(
            (item) =>
              institution.test(item) ||
              degree.test(item) ||
              /\b(?:major|strand|speciali[sz]ation)\b/i.test(item),
          );
          if (details.length) values.push(`${details.join(" · ")} — ${line}`);
          beforePeriod = [];
          continue;
        }
        if (
          institution.test(line) ||
          degree.test(line) ||
          /\b(?:major|strand|speciali[sz]ation)\b/i.test(line)
        )
          beforePeriod.push(line);
      }
      return { values, source: document.source };
    })
    .find((result) => result.values.length);
  const structuredEducation = documents
    .map((document) => {
      const lines = document.text
        .split(/\n/)
        .map((line) => line.trim().replace(/^[-–•]\s*/, ""))
        .filter(Boolean);
      const records: string[] = [];
      for (let index = 0; index < lines.length; index++) {
        if (!educationLevelHeading.test(lines[index])) continue;
        const values: string[] = [];
        for (const line of lines.slice(index + 1, index + 9)) {
          if (educationLevelHeading.test(line) || sectionBoundary.test(line))
            break;
          if (line) values.push(line);
        }
        const hasEducationEvidence = values.some(
          (line) => educationTerms.test(line) || educationPeriod.test(line),
        );
        if (!hasEducationEvidence) continue;
        const deduped = [...new Set(values)];
        const period = deduped.find((line) => educationPeriod.test(line));
        const details = deduped.filter((line) => line !== period);
        if (!details.length) continue;
        records.push(`${details.join(" · ")}${period ? ` — ${period}` : ""}`);
      }
      return { values: records, source: document.source };
    })
    .find((result) => result.values.length);
  const educationDocument = documents.find((document) =>
    document.text.split(/\n/).some((line) => educationTerms.test(line)),
  );
  const educationCandidates = [
    ...(educationTimeline?.values || []),
    ...(educationTimeline?.values.length
      ? []
      : structuredEducation?.values || []),
    ...(educationTimeline?.values.length || structuredEducation?.values.length
      ? []
      : educationSection.values.filter((line) => educationTerms.test(line))),
    ...(structuredEducation?.values.length || educationSection.values.length
      ? []
      : (educationDocument?.text || "")
          .split(/\n/)
          .filter((line) => educationTerms.test(line))),
  ].filter((line) => !credentialLine.test(line));
  const seenEducation = new Set<string>();
  const education = educationCandidates
    .filter((line) => {
      const normalized = line.toLocaleLowerCase().replace(/\s+/g, " ").trim();
      if (seenEducation.has(normalized)) return false;
      seenEducation.add(normalized);
      return true;
    })
    .slice(0, 5)
    .join(
      educationTimeline?.values.length || structuredEducation?.values.length
        ? "\n"
        : " · ",
    )
    .slice(0, 600);
  const availabilityMatch = firstMatch(
    new RegExp(`(?:^|\\n)\\s*[^\\n]*${availabilityPattern.source}[^\\n]*`, "i"),
  );
  const availability = availabilityMatch?.value.trim().slice(0, 300) || "";
  const experienceSection = section(experienceHeading, 7);
  const experienceDetails =
    (experienceSection.values.length
      ? experienceSection.values.join(" · ")
      : documents
          .map(
            (document) =>
              document.text.match(
                /(?:job|work(?:ing)?|employment|professional)\s+(?:experience|history)\s*[:\n]([\s\S]{0,800}?)(?=\n(?:education|skills|references|certifications|licenses?)\b|$)/i,
              )?.[1],
          )
          .find(Boolean) || ""
    )
      .trim()
      .slice(0, 600) || "";
  const skillsSection = section(skillsHeading, 16);
  const qualificationsSection = section(qualificationsHeading, 20);
  const skillLanguage =
    /\b(?:communication|customer|service|cash|handling|sales|pos|teamwork|team\s+work|adaptab|multitask|leadership|computer|office|excel|word|problem[ -]?solving|interpersonal|time\s+management|food|beverage|verbal|written|organis|collaborat|independent|flexib|responsib|reliab|detail)\b/i;
  const profileNoise = (line: string) =>
    !line ||
    /@|(?:^|\b)(?:profile|about\s+me|career\s+objective|objective|contact|phone|email|address|residence|sponsored\s+by)(?:\b|$)/i.test(
      line,
    ) ||
    addressIsSafe(line) ||
    educationTerms.test(line) ||
    credentialLine.test(line) ||
    (/^(?:\p{Lu}[\p{L}'’-]*\s+){1,4}\p{Lu}[\p{L}'’-]*$/u.test(line) &&
      !skillLanguage.test(line)) ||
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b.*\b(?:19|20)\d{2}\b/i.test(
      line,
    );
  const skillCandidates = [
    ...skillsSection.values.filter((line) => !profileNoise(line)),
    ...qualificationsSection.values.filter(
      (line) => !profileNoise(line) && skillLanguage.test(line),
    ),
  ];
  const skills = [...new Set(skillCandidates)]
    .slice(0, 16)
    .join("\n")
    .slice(0, 600);
  const certificationSection = section(certificationHeading, 8);
  const certificationDocument = documents.find((document) =>
    document.text
      .split(/\n/)
      .some(
        (line) => !certificationHeading.test(line) && credentialLine.test(line),
      ),
  );
  const certificationCandidates = [
    ...certificationSection.values,
    ...qualificationsSection.values.filter((line) => credentialLine.test(line)),
    ...(certificationSection.values.length
      ? []
      : (certificationDocument?.text || "")
          .split(/\n/)
          .map((line) => line.trim())
          .filter(
            (line) =>
              !certificationHeading.test(line) && credentialLine.test(line),
          )),
  ];
  const seenCertifications = new Set<string>();
  const certifications = certificationCandidates
    .filter((line) => {
      const normalized = line.toLocaleLowerCase().replace(/\s+/g, " ").trim();
      if (!normalized || seenCertifications.has(normalized)) return false;
      seenCertifications.add(normalized);
      return true;
    })
    .slice(0, 8)
    .join("\n")
    .slice(0, 600);
  const phoneMatch = firstMatch(phonePattern);
  const phone = phoneMatch?.value || "";
  for (const [key, value, source] of [
    ["phone", phone, phoneMatch?.source],
    [
      "education",
      education,
      educationTimeline?.source ||
        structuredEducation?.source ||
        educationSection.source ||
        educationDocument?.source,
    ],
    ["availability", availability, availabilityMatch?.source],
    ["experienceDetails", experienceDetails, experienceSection.source],
    ["skills", skills, skillsSection.source || qualificationsSection.source],
    [
      "certifications",
      certifications,
      certificationSection.source || certificationDocument?.source,
    ],
  ] as const)
    if (value) {
      evidence[key] = value;
      provenance[key] = source || "Submitted evidence";
    }
  if (detectedRoles.size > 1)
    warnings.push("Conflicting applied positions require HR verification.");
  if (detectedLocations.size > 1)
    warnings.push("Multiple preferred branches require HR verification.");
  return {
    name,
    email,
    residence: formalFact("residence", residence),
    residenceLocation,
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
