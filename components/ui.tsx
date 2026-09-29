"use client";
import { useEffect, useRef, useId } from "react";
import {
  X,
  Inbox,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Info,
  ArrowRight,
} from "lucide-react";

/** Keeps a help bubble within the visible viewport before it is shown. */
function positionHelpTip(event: React.SyntheticEvent<HTMLSpanElement>) {
  const trigger = event.currentTarget;
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const tooltipWidth = Math.min(320, viewportWidth * 0.75, viewportWidth - 32);
  const triggerBox = trigger.getBoundingClientRect();
  const triggerCenter = triggerBox.left + triggerBox.width / 2;
  const tooltipLeft = Math.min(
    Math.max(triggerCenter - tooltipWidth / 2, 16),
    viewportWidth - tooltipWidth - 16,
  );

  trigger.style.setProperty(
    "--tooltip-translate-x",
    `${Math.round(tooltipLeft - triggerCenter)}px`,
  );
}

/** Small, keyboard-accessible help for a term or calculation that needs context. */
export function HelpTip({
  children,
  label = "More information",
  className = "",
  icon,
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
  icon?: React.ReactNode;
}) {
  return (
    <span
      className={`info-tooltip help-tip ${className}`}
      tabIndex={0}
      aria-label={label}
      onFocus={positionHelpTip}
      onMouseEnter={positionHelpTip}
      onClick={(event) => {
        positionHelpTip(event);
        event.currentTarget.focus();
      }}
    >
      {icon || <Info size={15} aria-hidden />}
      <span role="tooltip">{children}</span>
    </span>
  );
}
export function Button({
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      type="button"
      {...props}
      className={`button ${variant} ${props.className || ""}`}
    >
      {children}
    </button>
  );
}
export function Card({
  children,
  className = "",
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section {...props} className={`card ${className}`}>
      {children}
    </section>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function StatusBadge({ status }: { status: string }) {
  const stageTones: Record<string, string> = {
    Screening: "blue",
    "Initial Interview": "purple",
    "Final Interview": "orange",
    Requirements: "amber",
    Onboarding: "green",
    Hired: "deep-green",
    Rejected: "red",
    Withdrawn: "neutral",
    Urgent: "red",
    High: "orange",
    Medium: "amber",
    Low: "green",
    Met: "green",
    Unclear: "amber",
    "Not Assessed": "neutral",
    "Not Met": "red",
    Active: "green",
    Resigned: "neutral",
    Terminated: "red",
    Issued: "green",
    Pending: "amber",
    Incomplete: "red",
    "For Replacement": "orange",
    Returned: "neutral",
  };
  const tone =
    stageTones[status] ||
    (status === "Not Connected"
      ? "neutral"
      : /Hired|Complete|Meets|Passed|Approved|Connected/.test(status)
        ? "green"
        : /Review|Response|Pending|High|Correction/.test(status)
          ? "orange"
          : /Rejected|Not Met|Failed|No-show/.test(status)
            ? "red"
            : /Interview|Progress|Scheduled|New|Onboarding/.test(status)
              ? "blue"
              : "neutral");
  return <Badge tone={tone}>{status}</Badge>;
}
export const recruitmentStages = [
  ["Screening", "blue"],
  ["Initial Interview", "purple"],
  ["Final Interview", "orange"],
  ["Requirements", "amber"],
  ["Onboarding", "green"],
  ["Hired", "deep-green"],
  ["Rejected", "red"],
  ["Withdrawn", "neutral"],
] as const;

export function RecruitmentStageGuide({
  currentStage,
}: {
  currentStage?: string;
}) {
  const currentIndex = recruitmentStages.findIndex(
    ([stage]) => stage === currentStage,
  );
  return (
    <ol className="recruitment-stage-guide" aria-label="Recruitment stages">
      {recruitmentStages.slice(0, 6).map(([stage, tone], index) => {
        const state =
          index < currentIndex
            ? "complete"
            : index === currentIndex
              ? "current"
              : "upcoming";
        return (
          <li className={`${tone} ${state}`} key={stage}>
            <span className="stage-number" aria-hidden="true">
              {index + 1}
            </span>
            <span>{stage}</span>
            {index < 5 && <ArrowRight className="stage-arrow" size={16} />}
          </li>
        );
      })}
    </ol>
  );
}
export function StageLegend() {
  return (
    <div className="stage-legend" aria-label="Recruitment stage legend">
      <strong>Stage guide</strong>
      <div className="stage-legend-items">
        {recruitmentStages.map(([stage, tone]) => (
          <span className={`stage-key ${tone}`} key={stage}>
            <i className="stage-dot" aria-hidden="true" />
            {stage}
          </span>
        ))}
      </div>
    </div>
  );
}
export function Avatar({
  name,
  small = false,
  imageUrl,
}: {
  name: string;
  small?: boolean;
  imageUrl?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`avatar ${small ? "small" : ""} color-${name.length % 4}`}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" />
      ) : (
        name
          .split(" ")
          .slice(0, 2)
          .map((n) => n[0])
          .join("")
      )}
    </span>
  );
}
export function ApplicantCard({
  name,
  reference,
}: {
  name: string;
  reference: string;
}) {
  return (
    <span className="applicant-cell">
      <Avatar name={name} />
      <span>
        <strong>{name}</strong>
        <small>{reference}</small>
      </span>
    </span>
  );
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className || ""}`} />;
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`input select ${props.className || ""}`} />
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: string[];
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <div className="tabs" aria-label="Workspace views">
      {items.map((item) => (
        <button
          key={item}
          aria-pressed={value === item}
          className={value === item ? "selected" : ""}
          onClick={() => onChange(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
export function ProgressBar({ value }: { value: number }) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Hiring progress"
    >
      <i style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}
export function EmptyState({
  title,
  description = "Try changing your filters or come back later.",
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Inbox size={30} />
      <h3>{title}</h3>
      <p>{description}</p>
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}
export function LoadingSkeleton() {
  return (
    <div className="skeleton" role="status" aria-label="Loading workspace">
      <div />
      <div />
      <div />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, []);
  return (
    <dialog
      aria-labelledby={titleId}
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="table-scroll">
      <table>{children}</table>
    </div>
  );
}
export function MetricCard({
  label,
  value,
  note,
  icon,
  href,
  tone = "",
}: {
  label: string;
  value: number;
  note: string;
  icon: React.ReactNode;
  href?: string;
  tone?: string;
}) {
  const content = (
    <>
      <div className="metric-top">
        <span>{label}</span>
        {icon}
      </div>
      <strong>{value}</strong>
      <div className="metric-note">
        {note}
        {href && <ChevronRight size={14} />}
      </div>
    </>
  );
  if (!href) return <div className={`metric ${tone}`}>{content}</div>;
  return (
    <a className={`metric ${tone}`} href={href}>
      {content}
    </a>
  );
}
export function Toast({
  message,
  onClose,
  tone = "success",
}: {
  message: string;
  onClose: () => void;
  tone?: "success" | "error" | "info";
}) {
  useEffect(() => {
    const timer = setTimeout(onClose, 6000);
    return () => clearTimeout(timer);
  }, [message, onClose]);
  return (
    <div
      className={`toast ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {tone === "error" ? (
        <AlertCircle size={18} />
      ) : tone === "info" ? (
        <Info size={18} />
      ) : (
        <CheckCircle2 size={18} />
      )}
      {message}
      <button onClick={onClose} aria-label="Dismiss notification">
        <X size={16} />
      </button>
    </div>
  );
}
