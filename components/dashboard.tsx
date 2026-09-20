"use client";
import Link from "next/link";
import { greetingName } from "@/lib/identity";
import {
  ArrowUpRight,
  ArrowRight,
  UsersRound,
  Inbox,
  ScanEye,
  CheckCheck,
  CalendarDays,
  UserCheck,
  UserX,
  Undo2,
  Clock3,
  MapPin,
  Plus,
  ChevronRight,
  TriangleAlert,
  Sun,
} from "lucide-react";
import { useApp } from "./provider";
import {
  Avatar,
  Badge,
  Card,
  MetricCard,
  ProgressBar,
  StatusBadge,
  StageLegend,
  LoadingSkeleton,
  EmptyState,
} from "./ui";
import { isActive } from "@/lib/recruitment";
import { formatDate, formatTime, monthKey } from "@/lib/dates";
export function Dashboard() {
  const { state } = useApp();
  if (!state) return <LoadingSkeleton />;
  const now = new Date();
  const timezone = state.preferences.timezone || "Asia/Manila";
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
  const apps = state.applications;
  const monthly = apps.filter(
    (a) =>
      monthKey(a.appliedAt, state.preferences.timezone) ===
      monthKey(now, state.preferences.timezone),
  );
  const metrics = [
    ["Total Applications", monthly.length, UsersRound, "All applications", ""],
    [
      "New",
      monthly.filter((a) => a.status === "New").length,
      Inbox,
      "Ready for a first look",
      "New",
    ],
    [
      "For Review",
      monthly.filter((a) => a.status === "For Review").length,
      ScanEye,
      "Your perspective matters",
      "For Review",
    ],
    [
      "Approved",
      monthly.filter((a) => a.status === "Approved").length,
      CheckCheck,
      "Moving forward",
      "Approved",
    ],
    [
      "Interviews",
      monthly.filter((a) => a.stage.includes("Interview") && isActive(a))
        .length,
      CalendarDays,
      "Conversations in progress",
      "interviews",
    ],
    [
      "Hired",
      monthly.filter((a) => a.status === "Hired").length,
      UserCheck,
      "New beginnings",
      "Hired",
    ],
    [
      "Rejected",
      monthly.filter((a) => a.status === "Rejected").length,
      UserX,
      "Applications closed",
      "Rejected",
    ],
    [
      "Withdrawn",
      monthly.filter((a) => a.status === "Withdrawn").length,
      Undo2,
      "Candidate withdrawals",
      "Withdrawn",
    ],
  ] as const;
  const upcoming = apps
    .flatMap((a) =>
      a.interviews
        .filter(
          (i) =>
            new Date(i.scheduledAt) > now &&
            ["Scheduled", "Confirmed"].includes(i.status),
        )
        .map((i) => ({ a, i })),
    )
    .sort((x, y) => x.i.scheduledAt.localeCompare(y.i.scheduledAt))
    .slice(0, 3);
  const attention = [
    {
      title: "Applications awaiting review",
      description: "Help the next chapter begin.",
      count: apps.filter((a) => a.status === "For Review").length,
      href: "/applications?status=For%20Review",
      icon: ScanEye,
    },
    {
      title: "Interview decisions",
      description: "Keep good conversations moving.",
      count: apps.filter((a) =>
        a.interviews.some((i) => i.status === "Attended"),
      ).length,
      href: "/applications?view=interviews",
      icon: CalendarDays,
    },
    {
      title: "Incomplete requirements",
      description: "A few details still to follow up.",
      count: apps.filter(
        (a) =>
          a.stage === "Requirements" &&
          a.requirements.some((r) => r.status !== "Complete"),
      ).length,
      href: "/applications?stage=Requirements",
      icon: CheckCheck,
    },
    {
      title: "Waiting for a response",
      description: "2+ days · review before taking action.",
      count: apps.filter(
        (a) =>
          a.status === "No Response" &&
          Date.now() - new Date(a.lastActivity).getTime() > 172800000,
      ).length,
      href: "/applications?status=No%20Response",
      icon: Clock3,
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">RECRUITMENT WORKSPACE</div>
          <h1>
            Good {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"},{" "}
            {greetingName(state.currentUser?.name)}{" "}
            <Sun className="sun" size={24} aria-hidden="true" />
          </h1>
          <p>Here&apos;s what&apos;s happening with recruitment today.</p>
        </div>
        <div className="date-label">
          <CalendarDays size={17} />
          {formatDate(now, state.preferences)}
        </div>
      </div>
      <div className="section-heading">
        <h2>Recruitment at a glance</h2>
        <span className="muted">
          {now.toLocaleDateString("en-US", {
            timeZone: timezone,
            month: "long",
            year: "numeric",
          })}
        </span>
      </div>
      <div className="metrics-grid">
        {metrics.map(([label, value, Icon, note, status], i) => (
          <MetricCard
            key={label}
            label={label}
            value={value}
            note={note}
            icon={<Icon size={20} />}
            href={`/applications?${status === "interviews" ? "view=interviews" : `status=${encodeURIComponent(status)}`}&month=current`}
            tone={i === 0 ? "featured" : i === 5 ? "hired" : ""}
          />
        ))}
      </div>
      <StageLegend />
      <div className="dashboard-columns">
        <div>
          <Card>
            <div className="card-heading">
              <div>
                <h2>
                  Active hiring needs{" "}
                  <Badge>
                    {
                      state.hiringNeeds.filter((n) => n.status === "Open")
                        .length
                    }
                  </Badge>
                </h2>
                <p>Finding the right people for every branch.</p>
              </div>
              <Link className="text-link" href="/hiring-needs">
                View all <ArrowUpRight size={16} />
              </Link>
            </div>
            <div className="hiring-list">
              {state.hiringNeeds
                .filter((n) => n.status === "Open")
                .map((need) => (
                  <Link
                    href={`/hiring-needs?edit=${need.id}`}
                    key={need.id}
                    className="hiring-row"
                  >
                    <span className="job-icon">
                      <UsersRound size={21} />
                    </span>
                    <div className="job-description">
                      <strong>{need.position}</strong>
                      <span>
                        <MapPin size={12} />
                        {need.location}
                      </span>
                    </div>
                    <div className="hiring-slots">
                      <strong>{need.slots - need.filled} open slots</strong>
                      <span>
                        {
                          apps.filter(
                            (a) =>
                              a.position === need.position &&
                              a.location === need.location &&
                              isActive(a),
                          ).length
                        }{" "}
                        in pipeline
                      </span>
                    </div>
                    <div className="hiring-progress">
                      <StatusBadge status={`${need.urgency} priority`} />
                      <ProgressBar value={(need.filled / need.slots) * 100} />
                    </div>
                    <ChevronRight size={17} />
                  </Link>
                ))}
            </div>
            <Link href="/hiring-needs?new=1" className="card-bottom-link">
              <Plus size={16} /> Create a hiring need
            </Link>
          </Card>
          <Card className="recent-card">
            <div className="card-heading">
              <div>
                <h2>Recent applications</h2>
                <p>Meet the people who want to join us.</p>
              </div>
              <Link className="text-link" href="/applications">
                View all <ArrowUpRight size={16} />
              </Link>
            </div>
            <div className="recent-list">
              {apps.slice(0, 4).map((a) => (
                <Link
                  key={a.id}
                  href={`/applications/${a.id}`}
                  className="recent-row"
                >
                  <Avatar name={a.applicant.name} />
                  <div>
                    <strong>{a.applicant.name}</strong>
                    <span>
                      {a.position} · {a.location}
                    </span>
                  </div>
                  <StatusBadge status={a.status} />
                  <ArrowUpRight size={16} />
                </Link>
              ))}
            </div>
          </Card>
        </div>
        <div>
          <Card className="attention-card">
            <div className="card-heading">
              <div>
                <h2>
                  <TriangleAlert size={18} aria-hidden="true" /> Needs your
                  attention
                </h2>
                <p>Follow-ups and outstanding requirements.</p>
              </div>
              <Badge tone="orange">
                {attention.reduce((total, item) => total + item.count, 0)}{" "}
                actions
              </Badge>
            </div>
            {attention
              .filter((item) => item.count > 0)
              .map(({ title, description, count, href, icon: Icon }) => (
                <Link href={href} className="attention-row" key={title}>
                  <span className="attention-icon">
                    <Icon size={18} />
                  </span>
                  <div>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </div>
                  <span className="attention-count">{count}</span>
                </Link>
              ))}
            {!attention.some((item) => item.count > 0) && (
              <div className="padded">
                <p>
                  You’re all caught up. New items will appear as recruitment
                  progresses.
                </p>
              </div>
            )}
            <Link className="attention-foot" href="/hiring-needs">
              {
                state.hiringNeeds.filter(
                  (n) =>
                    ["High", "Urgent"].includes(n.urgency) &&
                    n.filled < n.slots &&
                    n.status === "Open",
                ).length
              }{" "}
              urgent hiring needs remain underfilled <ArrowRight size={15} />
            </Link>
          </Card>
          <Card className="interview-card">
            <div className="card-heading">
              <div>
                <h2>Upcoming interviews</h2>
                <p>A chance to get to know someone.</p>
              </div>
              <CalendarDays size={19} />
            </div>
            {upcoming.length ? (
              upcoming.map(({ a, i }) => (
                <Link
                  key={i.id}
                  className="interview-row"
                  href={`/applications/${a.id}`}
                >
                  <div className="calendar-tile">
                    <span>
                      {new Date(i.scheduledAt).toLocaleDateString("en-US", {
                        timeZone: timezone,
                        month: "long",
                      })}
                    </span>
                    <strong>
                      {new Date(i.scheduledAt).toLocaleDateString("en-US", {
                        timeZone: timezone,
                        day: "numeric",
                      })}
                    </strong>
                  </div>
                  <div>
                    <strong>{a.applicant.name}</strong>
                    <span>
                      {i.stage} · {a.position}
                    </span>
                    <small>
                      {formatTime(i.scheduledAt, state.preferences)}
                    </small>
                  </div>
                  <ChevronRight size={15} />
                </Link>
              ))
            ) : (
              <EmptyState title="No upcoming interviews" />
            )}
          </Card>
          <div className="daily-note">
            <span>THE DAILY REMINDER</span>
            <p>
              Every great team starts
              <br />
              with a conversation.
            </p>
            <span className="note-line" />
          </div>
        </div>
      </div>
    </>
  );
}
