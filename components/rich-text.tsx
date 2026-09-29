"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  onBlur?: (value: string) => void;
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
  onBlur,
  placeholder,
  maxLength,
  rows = 4,
  disabled = false,
  required = false,
  "aria-label": ariaLabel,
}: EditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const hiddenInput = useRef<HTMLInputElement>(null);
  const selectionRange = useRef<Range | null>(null);
  const [content, setContent] = useState(value ?? defaultValue);
  const [toolbarPosition, setToolbarPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
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
    if (maxLength && next.length > maxLength) return content;
    // Keep the form value in lockstep with the editable surface. Form-level
    // draft handlers can run during this input event, before React has had a
    // chance to commit the next render.
    if (hiddenInput.current) hiddenInput.current.value = next;
    setContent(next);
    onChange?.(next);
    return next;
  };
  const captureSelection = useCallback(() => {
    const element = root.current;
    const selection = window.getSelection();
    if (
      !element ||
      !selection ||
      !selection.rangeCount ||
      selection.isCollapsed ||
      !element.contains(selection.getRangeAt(0).commonAncestorContainer)
    ) {
      selectionRange.current = null;
      setToolbarPosition(null);
      return;
    }
    const range = selection.getRangeAt(0).cloneRange();
    const selectionRect = range.getBoundingClientRect();
    if (!selectionRect.width && !selectionRect.height) return;
    const toolbarWidth = Math.min(292, window.innerWidth - 16);
    selectionRange.current = range;
    setToolbarPosition({
      left: Math.max(
        8,
        Math.min(selectionRect.left, window.innerWidth - toolbarWidth - 8),
      ),
      // Keep the selected words unobstructed. The bubble sits above the
      // selection whenever possible and flips beneath it near the viewport top.
      top:
        selectionRect.top > 56
          ? selectionRect.top - 44
          : selectionRect.bottom + 8,
    });
  }, []);
  useEffect(() => {
    document.addEventListener("selectionchange", captureSelection);
    return () => document.removeEventListener("selectionchange", captureSelection);
  }, [captureSelection]);
  const dismissSelectionToolbar = () => {
    selectionRange.current = null;
    setToolbarPosition(null);
  };
  const command = (action: string) => {
    if (disabled || !root.current) return;
    const selection = window.getSelection();
    if (selectionRange.current && selection) {
      selection.removeAllRanges();
      selection.addRange(selectionRange.current);
    }
    root.current.focus();
    if (action === "quote") document.execCommand("formatBlock", false, "blockquote");
    else document.execCommand(action, false);
    update();
    // The toolbar is the only control that alters formatting. Once an action
    // has run, dismiss the selection UI instead of leaving it over the text or
    // making HR click elsewhere just to continue editing.
    selection?.removeAllRanges();
    dismissSelectionToolbar();
  };
  return (
    <div className={`rich-text-editor${disabled ? " is-disabled" : ""}`}>
      {name && <input ref={hiddenInput} type="hidden" name={name} value={content} />}
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
        onInput={() => void update()}
        onBlur={() => onBlur?.(update())}
        onMouseDown={dismissSelectionToolbar}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
      />
      {toolbarPosition && (
        <div
          className="rich-text-toolbar rich-text-selection-toolbar"
          role="toolbar"
          aria-label="Selected text formatting"
          style={toolbarPosition}
        >
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
      )}
      <small className="rich-text-hint">
        Select text to format it. Formatting is saved with this note.
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
