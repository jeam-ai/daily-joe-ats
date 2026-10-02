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
  const source = escapeHtml(value);
  const tokens = [
    ["**", "strong"],
    ["__", "u"],
    ["~~", "s"],
    ["*", "em"],
  ] as const;
  // Parse nested toolbar marks, including bold + italic (***text***). Regex
  // replacements lose nested formatting when the editor is blurred or reopened.
  const parse = (
    start: number,
    closing?: string,
  ): { html: string; end: number; closed: boolean } => {
    let html = "",
      index = start;
    while (index < source.length) {
      if (closing && source.startsWith(closing, index))
        return { html, end: index + closing.length, closed: true };
      const token = tokens.find(([marker]) => source.startsWith(marker, index));
      if (token) {
        const [marker, tag] = token;
        const nested = parse(index + marker.length, marker);
        if (nested.closed) {
          html += `<${tag}>${nested.html}</${tag}>`;
          index = nested.end;
          continue;
        }
        html += marker;
        index += marker.length;
      } else html += source[index++];
    }
    return { html, end: index, closed: false };
  };
  return parse(0).html;
}

/** Render the supported persisted format as already-sanitized HTML. */
export function richTextToHtml(value?: string) {
  const lines = String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const lists: { type: "ul" | "ol"; indent: number; itemOpen: boolean }[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map(inline).join("<br />")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    const list = lists.pop();
    if (!list) return;
    if (list.itemOpen) blocks.push("</li>");
    blocks.push(`</${list.type}>`);
  };
  const flushList = () => {
    while (lists.length) closeList();
  };
  for (const line of lines) {
    const quote = /^>\s?(.*)$/.exec(line);
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote><p>${inline(quote[1])}</p></blockquote>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const type: "ul" | "ol" = numbered ? "ol" : "ul";
      const match = (bullet || numbered)!;
      const indent = match[1].replace(/\t/g, "  ").length;
      while (lists.length && lists.at(-1)!.indent > indent) closeList();
      if (lists.at(-1)?.indent === indent && lists.at(-1)?.type !== type)
        closeList();
      if (!lists.length || lists.at(-1)!.indent < indent) {
        blocks.push(
          `<${type}${!lists.length && indent > 0 ? ` style="margin-left: ${(indent / 2) * 24}px"` : ""}>`,
        );
        lists.push({ type, indent, itemOpen: false });
      }
      const list = lists.at(-1)!;
      if (list.itemOpen) blocks.push("</li>");
      blocks.push(`<li>${inline(match[2])}`);
      list.itemOpen = true;
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
    .split("\n")
    .map((line) =>
      inline(line)
        .replace(/<\/?(?:strong|em|u|s)>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&"),
    )
    .join("\n")
    .replace(/^>\s?/gm, "")
    .trim();
}

/** Turn toolbar-produced HTML back into the compact persisted format. */
export function editorHtmlToRichText(root: HTMLElement) {
  type Marks = {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
  };
  const read = (node: Node, inherited: Marks = {}): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      let text = node.textContent || "";
      if (!text) return "";
      if (inherited.italic) text = `*${text}*`;
      if (inherited.bold) text = `**${text}**`;
      if (inherited.underline) text = `__${text}__`;
      if (inherited.strike) text = `~~${text}~~`;
      return text;
    }
    if (!(node instanceof HTMLElement)) return "";
    const marks = { ...inherited };
    if (["STRONG", "B"].includes(node.tagName)) marks.bold = true;
    if (["EM", "I"].includes(node.tagName)) marks.italic = true;
    if (node.tagName === "U") marks.underline = true;
    if (["S", "STRIKE"].includes(node.tagName)) marks.strike = true;
    // Browsers may produce styled spans rather than semantic tags. Explicit
    // normal styles also override an ancestor when a toolbar mark is removed.
    if (node.style.fontWeight)
      marks.bold =
        node.style.fontWeight === "bold" ||
        Number(node.style.fontWeight) >= 600;
    if (node.style.fontStyle) marks.italic = node.style.fontStyle === "italic";
    const decoration =
      node.style.textDecorationLine || node.style.textDecoration;
    if (decoration) {
      marks.underline = decoration.includes("underline");
      marks.strike = decoration.includes("line-through");
    }
    const content = Array.from(node.childNodes)
      .map((child) => read(child, marks))
      .join("");
    switch (node.tagName) {
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
      case "OL":
        return `${readList(node, marks, Math.max(0, Math.round(parseFloat(node.style.marginLeft || "0") / 24)))}\n\n`;
      case "DIV":
      case "P":
        return `${content}\n`;
      default:
        return content;
    }
  };
  const readList = (list: HTMLElement, marks: Marks, depth: number): string => {
    let index = 0;
    return Array.from(list.children)
      .map((item) => {
        if (!(item instanceof HTMLElement)) return "";
        if (["UL", "OL"].includes(item.tagName))
          return readList(item, marks, depth + 1);
        const body = Array.from(item.childNodes)
          .filter(
            (child) =>
              !(
                child instanceof HTMLElement &&
                ["UL", "OL"].includes(child.tagName)
              ),
          )
          .map((child) => read(child, marks))
          .join("")
          .trim();
        const marker = list.tagName === "OL" ? `${++index}.` : "-";
        const nested = Array.from(item.children)
          .filter(
            (child): child is HTMLElement =>
              child instanceof HTMLElement &&
              ["UL", "OL"].includes(child.tagName),
          )
          .map((child) => readList(child, marks, depth + 1));
        return [`${"  ".repeat(depth)}${marker} ${body}`, ...nested].join("\n");
      })
      .join("\n");
  };
  return Array.from(root.childNodes)
    .map((node) => read(node))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}
