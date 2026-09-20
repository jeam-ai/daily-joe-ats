import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const css = readFileSync("app/polish.css", "utf8");
const luminance = (hex: string) => {
  const [r, g, b] = hex
    .slice(1)
    .match(/../g)!
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
test("both themes preserve AA contrast across text, hover surfaces, status colors and primary buttons", () => {
  for (const [name, block] of [
    ["Light", css.match(/:root\s*{([^}]+)/)![1]],
    ["Dark", css.match(/html\[data-theme="dark"\]\s*{([^}]+)/)![1]],
  ]) {
    const tokens = Object.fromEntries(
      [...block.matchAll(/--([a-z-]+):\s*(#[a-f0-9]{6});/gi)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const pairs = [
      ...["text-primary", "text-secondary", "text-muted"].flatMap((text) =>
        ["background", "surface", "surface-hover"].map((surface) => [
          text,
          surface,
        ]),
      ),
      ...["success", "warning", "danger", "info", "orange", "purple"].map(
        (status) => [status, `${status}-bg`],
      ),
      ["on-accent", "accent"],
      ["on-accent", "accent-hover"],
    ];
    for (const [fg, bg] of pairs) {
      const a = luminance(tokens[fg]),
        b = luminance(tokens[bg]);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(ratio >= 4.5, `${name} ${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
    }
  }
});
