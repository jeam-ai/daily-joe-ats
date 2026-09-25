"use client";
import { IntakeSyncStatus } from "./intake-sync";
import Link from "next/link";
import { canManage } from "@/lib/data-policy";
import { DemoControls } from "./system-settings";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import {
  House,
  UsersRound,
  BriefcaseBusiness,
  Bookmark,
  ChartNoAxesCombined,
  Settings,
  Bell,
  Search,
  ChevronDown,
  Menu,
  ShieldCheck,
  ArrowUpRight,
  LogOut,
  Clock3,
  X,
  Mail,
} from "lucide-react";
import { AppProvider, useApp } from "./provider";
import { Avatar, Badge, Button } from "./ui";
import Image from "next/image";
import { RouteFeedback } from "./route-feedback";
const navigation = [
  ["Home", "/", House],
  ["Applications", "/applications", UsersRound],
  ["Hiring Needs", "/hiring-needs", BriefcaseBusiness],
  ["Talent Pool", "/talent-pool", Bookmark],
  ["Timekeeping", "/timekeeping", Clock3],
  ["Reports", "/reports", ChartNoAxesCombined],
  ["Settings", "/settings", Settings],
] as const;
function Frame({
  children,
  email,
  name,
  demo,
}: {
  children: React.ReactNode;
  email?: string;
  name?: string;
  demo: boolean;
}) {
  const path = usePathname();
  const router = useRouter();
  const { state, dataset } = useApp();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = matchMedia("(max-width: 700px)");
    const apply = () => {
      setMobile(media.matches);
      if (!media.matches) setOpen(false);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const prefetched = useRef(false);
  useEffect(() => {
    if (prefetched.current) return;
    const timer = window.setTimeout(() => {
      prefetched.current = true;
      for (const [, href] of navigation)
        if (href !== path) router.prefetch(href);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [path, router]);
  useEffect(() => {
    if (!open) return;
    const focusable = () =>
      Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled])",
        ) || [],
      ).filter((el) => el.offsetParent !== null);
    focusable()[0]?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        requestAnimationFrame(() => menuButton.current?.focus());
      }
      if (e.key === "Tab") {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);
  const active = navigation.find(([, href]) =>
    href === "/" ? path === "/" : path.startsWith(href),
  );
  return (
    <div className={`app-shell ${state?.preferences.compact ? "compact" : ""}`}>
      {open && (
        <button
          className="mobile-backdrop"
          tabIndex={-1}
          aria-hidden="true"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        ref={sidebar}
        inert={mobile && !open}
        aria-hidden={mobile && !open ? true : undefined}
        aria-label="Workspace navigation"
        id="workspace-navigation"
        className={`sidebar ${open ? "mobile-open" : ""}`}
      >
        <button
          className="icon-button sidebar-close"
          aria-label="Close navigation"
          onClick={() => {
            setOpen(false);
            requestAnimationFrame(() => menuButton.current?.focus());
          }}
        >
          <X size={20} />
        </button>
        <Link href="/" className="brand" onClick={() => setOpen(false)}>
          <Image
            className="brand-logo"
            src="/daily-joe-logo-blue.png"
            alt="Daily Joe Careers"
            width={170}
            height={74}
            priority
          />
          <span className="brand-careers">CAREERS</span>
        </Link>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav>
          {navigation.map(([label, href, Icon]) => (
            <Link
              href={href}
              key={href}
              onClick={() => setOpen(false)}
              title={label}
              aria-current={active?.[1] === href ? "page" : undefined}
              className={active?.[1] === href ? "active" : ""}
            >
              <Icon size={19} />
              <span>{label}</span>
              {label === "Applications" && (
                <span className="nav-count">
                  {state ? state.applicationSummary?.[dataset].liveQueue ?? 0 : "…"}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <ShieldCheck size={22} />
            <strong>Daily Joe Careers</strong>
            <p>Recruitment and HR operations.</p>
          </div>
          <Link href="/settings/account" className="sidebar-profile">
            <Avatar
              name={state?.currentUser?.name || name || email || "HR"}
              imageUrl={state?.currentUser?.avatarUrl}
              small
            />
            <span>
              {state?.currentUser?.name || name || email}
              <small>{state?.currentUser?.title}</small>
            </span>
            <ChevronDown size={15} />
          </Link>
        </div>
      </aside>
      <div className="main-shell" inert={open}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button menu-toggle"
              ref={menuButton}
              aria-expanded={open}
              aria-controls="workspace-navigation"
              onClick={() => setOpen(!open)}
              aria-label="Toggle navigation"
            >
              <Menu size={21} />
            </button>
            <span>Workspace</span>
            <span>/</span>
            <strong>{active?.[0] || "Notifications"}</strong>
          </div>
          <div className="topbar-actions">
            <form action="/applications" className="global-search">
              <Search size={16} />
              <input
                aria-label="Search applicants"
                name="q"
                placeholder="Search applicants…"
              />
              <kbd>↵</kbd>
            </form>
            <Badge tone="blue">
              {dataset === "demo" ? "DEMO" : "LIVE WORKSPACE"} ·{" "}
              {!state ? "…" : state.applicationSummary?.[dataset].active ?? 0}{" "}
              / 100 active
            </Badge>
            <Link
              className="icon-button notification-button"
              href="/notifications"
              aria-label="Notifications"
            >
              <Bell size={19} />
              {state?.preferences.notifications !== false &&
                state?.notifications.some((n) => !n.read) && <i />}
            </Link>
            <Link href="/settings/account" aria-label="Your profile">
              <Avatar
                name={state?.currentUser?.name || name || email || "HR"}
                imageUrl={state?.currentUser?.avatarUrl}
                small
              />
            </Link>
          </div>
        </header>
        <RouteFeedback />
        <main id="main-content">
          <DemoControls banner />
          {!path.startsWith("/timekeeping") && <IntakeSyncStatus />}
          {children}
        </main>
        <footer className="workspace-footer">
          <span>DAILY JOE CAREERS</span>
          <span>
            {email
              ? `Signed in as ${state?.currentUser?.name || name || email}`
              : "Authorized recruitment workspace"}
          </span>
          <a href="/api/auth/logout" aria-label="Sign out">
            <LogOut size={14} />
          </a>
        </footer>
      </div>
    </div>
  );
}
export function Shell(props: {
  children: React.ReactNode;
  email?: string;
  name?: string;
  demo: boolean;
}) {
  return (
    <AppProvider email={props.email}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Frame {...props} />
    </AppProvider>
  );
}
