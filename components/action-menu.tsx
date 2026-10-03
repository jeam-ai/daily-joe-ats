"use client";
import { useEffect, useRef, useState, useId } from "react";
import { createPortal, flushSync } from "react-dom";
import { Ellipsis } from "lucide-react";
type Item = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  reason?: string;
};
export function ActionMenu({
  label = "Applicant actions",
  items,
}: {
  label?: string;
  items: Item[];
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const button = trigger.current;
    const context = (event: Event) => {
      const point = (event as CustomEvent<{ x: number; y: number }>).detail;
      setPosition({
        top: Math.max(
          8,
          Math.min(point.y, window.innerHeight - items.length * 42 - 24),
        ),
        left: Math.max(8, Math.min(point.x, window.innerWidth - 238)),
      });
      setOpen(true);
    };
    button?.addEventListener("record-context-menu", context);
    return () => button?.removeEventListener("record-context-menu", context);
  }, [items.length]);
  useEffect(() => {
    if (!open) return;
    menu.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const close = (event: Event) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const resize = () => setOpen(false);
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", resize, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", resize, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        data-record-menu
        type="button"
        className="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          const rect = trigger.current!.getBoundingClientRect();
          setPosition({
            top: Math.max(
              8,
              Math.min(
                rect.bottom + 6,
                window.innerHeight - items.length * 42 - 24,
              ),
            ),
            left: Math.max(
              8,
              Math.min(rect.right - 230, window.innerWidth - 238),
            ),
          });
          setOpen(!open);
        }}
      >
        <Ellipsis size={20} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            className="action-menu"
            style={position}
            role="menu"
            aria-label={label}
            onKeyDown={(event) => {
              const buttons = Array.from(
                menu.current!.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              );
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                buttons[
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (event.key === "ArrowUp" ? -1 : 1) +
                          buttons.length) %
                        buttons.length
                ]?.focus();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              }
              if (event.key === "Tab") setOpen(false);
            }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                type="button"
                disabled={item.disabled}
                title={item.reason}
                className={item.danger ? "destructive-text" : ""}
                onClick={() => {
                  flushSync(() => setOpen(false));
                  trigger.current?.focus();
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          trigger.current?.closest("dialog") || document.body,
        )}
    </>
  );
}
