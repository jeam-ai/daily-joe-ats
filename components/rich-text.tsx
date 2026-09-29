"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  IndentDecrease,
  IndentIncrease,
  Quote,
} from "lucide-react";
import { editorHtmlToRichText, richTextToHtml } from "@/lib/rich-text";

type EditorProps = {
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  rows?: number;
  disabled?: boolean;
  required?: boolean;
  "aria-label"?: string;
};

const actions = [
  ["bold", Bold, "Bold"],
  ["italic", Italic, "Italic"],
  ["underline", Underline, "Underline"],
  ["strikeThrough", Strikethrough, "Strikethrough"],
  ["insertUnorderedList", List, "Bulleted list"],
  ["insertOrderedList", ListOrdered, "Numbered list"],
  ["outdent", IndentDecrease, "Decrease indent"],
  ["indent", IndentIncrease, "Increase indent"],
] as const;

export function RichTextEditor({
  name,
  value,
  defaultValue = "",
  onChange,
  placeholder,
  maxLength,
  rows = 4,
  disabled = false,
  required = false,
  "aria-label": ariaLabel,
}: EditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState(value ?? defaultValue);
  const controlled = value !== undefined;
  useEffect(() => {
    if (controlled && value !== content && document.activeElement !== root.current)
      setContent(value);
  }, [content, controlled, value]);
  useLayoutEffect(() => {
    const element = root.current;
    const html = richTextToHtml(content);
    // Never rewrite an actively edited surface: replacing its HTML moves the
    // selection/caret and makes typing feel like the editor is jumping back.
    if (element && document.activeElement !== element && element.innerHTML !== html)
      element.innerHTML = html;
  }, [content]);
  const update = () => {
    const next = root.current ? editorHtmlToRichText(root.current) : "";
    if (maxLength && next.length > maxLength) return;
    setContent(next);
    onChange?.(next);
  };
  const command = (action: string) => {
    if (disabled || !root.current) return;
    root.current.focus();
    if (action === "quote") document.execCommand("formatBlock", false, "blockquote");
    else document.execCommand(action, false);
    update();
  };
  return (
    <div className={`rich-text-editor${disabled ? " is-disabled" : ""}`}>
      {name && <input type="hidden" name={name} value={content} />}
      <div className="rich-text-toolbar" role="toolbar" aria-label="Text formatting">
        {actions.map(([action, Icon, label]) => (
          <button
            type="button"
            key={action}
            title={label}
            aria-label={label}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(action)}
          >
            <Icon size={15} />
          </button>
        ))}
        <button
          type="button"
          title="Quote"
          aria-label="Quote"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => command("quote")}
        >
          <Quote size={15} />
        </button>
      </div>
      <div
        ref={root}
        className="rich-text-surface"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-label={ariaLabel || "Formatted text"}
        aria-multiline="true"
        aria-required={required || undefined}
        data-placeholder={placeholder}
        style={{ minHeight: `${Math.max(2, rows) * 1.5}rem` }}
        onInput={update}
        onBlur={update}
      />
      <small className="rich-text-hint">
        Formatting is saved with this note.
      </small>
    </div>
  );
}

export function RichTextContent({
  value,
  className,
}: {
  value?: string;
  className?: string;
}) {
  if (!value?.trim()) return null;
  return (
    <div
      className={`rich-text-content${className ? ` ${className}` : ""}`}
      dangerouslySetInnerHTML={{ __html: richTextToHtml(value) }}
    />
  );
}
