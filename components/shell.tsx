"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
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
  Coffee,
  ArrowUpRight,
  LogOut,
} from "lucide-react";
import { AppProvider, useApp } from "./provider";
import { Avatar, Badge } from "./ui";
import Image from "next/image";
const navigation = [
  ["Home", "/", House],
  ["Applications", "/applications", UsersRound],
  ["Hiring Needs", "/hiring-needs", BriefcaseBusiness],
  ["Talent Pool", "/talent-pool", Bookmark],
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
  const { state } = useApp();
  const [open, setOpen] = useState(false);
  const active = navigation.find(([, href]) =>
    href === "/" ? path === "/" : path.startsWith(href),
  );
  return (
    <div className={`app-shell ${state?.preferences.compact ? "compact" : ""}`}>
      <aside className={`sidebar ${open ? "mobile-open" : ""}`}>
        <Link href="/" className="brand">
          <Image
            className="brand-logo"
            src="/daily-joe-logo-blue.png"
            alt="Daily Joe"
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
              className={active?.[1] === href ? "active" : ""}
            >
              <Icon size={19} />
              <span>{label}</span>
              {label === "Applications" && (
                <span className="nav-count">
                  {state?.applications.filter((a) => a.status === "New")
                    .length || 0}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Coffee size={22} />
            <strong>
              Good people.
              <br />
              Great beginnings.
            </strong>
            <p>
              Build the team behind
              <br />
              every Daily Joe moment.
            </p>
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
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button menu-toggle"
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
              Workspace · {state?.applications.length || 0}/
              {state?.importLimit || 100}
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
                name={state?.currentUser?.name || email || "HR"}
                imageUrl={state?.currentUser?.avatarUrl}
                small
              />
            </Link>
          </div>
        </header>
        <main id="main-content">{children}</main>
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
    <AppProvider>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Frame {...props} />
    </AppProvider>
  );
}
