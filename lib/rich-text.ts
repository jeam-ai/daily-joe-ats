/**
 * Small, portable rich-text format for HR notes and templates.
 *
 * Values are persisted as readable Markdown-like text rather than browser HTML,
 * so a note remains safe to export, search, or view outside the editor. The
 * renderer escapes all submitted characters before applying the supported
 * formatting tokens.
 */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(value: string) {
  let rendered = escapeHtml(value);
  // Keep the supported toolbar output deliberately small and predictable.
  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  rendered = rendered.replace(/__([^_]+)__/g, "<u>$1</u>");
  rendered = rendered.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  rendered = rendered.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return rendered;
}

/** Render the supported persisted format as already-sanitized HTML. */
export function richTextToHtml(value?: string) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map(inline).join("<br />")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(`<${list.type}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  for (const line of lines) {
    const quote = /^>\s?(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote><p>${inline(quote[1])}</p></blockquote>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const type: "ul" | "ol" = numbered ? "ol" : "ul";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((bullet || numbered)![1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks.join("") || "<p></p>";
}

/** Plain-text alternative for email clients and exports that do not render HTML. */
export function richTextToPlainText(value?: string) {
  return String(value || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/^>\s?/gm, "")
    .trim();
}

/** Turn toolbar-produced HTML back into the compact persisted format. */
export function editorHtmlToRichText(root: HTMLElement) {
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (!(node instanceof HTMLElement)) return "";
    const content = Array.from(node.childNodes).map(read).join("");
    switch (node.tagName) {
      case "STRONG":
      case "B":
        return `**${content}**`;
      case "EM":
      case "I":
        return `*${content}*`;
      case "U":
        return `__${content}__`;
      case "S":
      case "STRIKE":
        return `~~${content}~~`;
      case "BR":
        return "\n";
      case "BLOCKQUOTE":
        return `${content
          .split("\n")
          .filter(Boolean)
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`;
      case "LI":
        return content.trim();
      case "UL":
        return `${Array.from(node.children)
          .map((item) => `- ${read(item).trim()}`)
          .join("\n")}\n\n`;
      case "OL":
        return `${Array.from(node.children)
          .map((item, index) => `${index + 1}. ${read(item).trim()}`)
          .join("\n")}\n\n`;
      case "DIV":
      case "P":
        return `${content}\n`;
      default:
        return content;
    }
  };
  return Array.from(root.childNodes)
    .map(read)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
