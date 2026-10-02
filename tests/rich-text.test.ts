import test from "node:test";
import assert from "node:assert/strict";
import { richTextToHtml, richTextToPlainText } from "../lib/rich-text";

test("nested toolbar marks survive rendering and plain-text export", () => {
  const note =
    "***Bold and italic*** then __**underlined bold**__ and ~~removed~~";
  assert.equal(
    richTextToHtml(note),
    "<p><strong><em>Bold and italic</em></strong> then <u><strong>underlined bold</strong></u> and <s>removed</s></p>",
  );
  assert.equal(
    richTextToPlainText(note),
    "Bold and italic then underlined bold and removed",
  );
  assert.equal(
    richTextToHtml("**<script>alert('x')</script>**"),
    "<p><strong>&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;</strong></p>",
  );
});

test("list markers are retained alongside text formatting", () => {
  assert.equal(
    richTextToHtml("1. **First**\n2. Second"),
    "<ol><li><strong>First</strong></li><li>Second</li></ol>",
  );
  assert.equal(
    richTextToHtml("- **First**\n- Second"),
    "<ul><li><strong>First</strong></li><li>Second</li></ul>",
  );
  assert.equal(
    richTextToHtml("An unmatched **marker"),
    "<p>An unmatched **marker</p>",
  );
  assert.equal(
    richTextToHtml("1. Parent\n  1. Child\n2. Next"),
    "<ol><li>Parent<ol><li>Child</li></ol></li><li>Next</li></ol>",
  );
  assert.equal(
    richTextToHtml("- Parent\n  - Child\n- Next"),
    "<ul><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ul>",
  );
});
