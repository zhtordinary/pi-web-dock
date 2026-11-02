import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseSkillContent } = await jiti.import("./skill-content.ts");

test("splits frontmatter from the complete Markdown body without interpreting it", () => {
  const content = "---\nname: review\ndescription: Review\n---\n\n# Instructions\n\n<script>alert(1)</script>\n";
  assert.deepEqual(parseSkillContent(content), {
    frontmatter: { name: "review", description: "Review" },
    body: "\n# Instructions\n\n<script>alert(1)</script>\n",
  });
});

test("keeps documents without frontmatter intact", () => {
  const content = "# Plain skill\n\nBody\n";
  assert.deepEqual(parseSkillContent(content), { frontmatter: null, body: content });
});
