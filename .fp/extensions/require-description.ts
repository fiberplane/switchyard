import type { ExtensionInit } from "@fiberplane/extensions";

const GUIDANCE = [
  "Issues must include a description. Before creating or updating, consider:",
  "",
  "  • What problem does this solve? What's the expected behavior?",
  "  • Have you explored the relevant code or docs?",
  "  • Are there edge cases, risks, or open questions?",
  "",
  "If you haven't scoped the work yet, set the description to:",
  '  "NOTE: requires additional research before implementation"',
];

const hasEmptyDescription = (description: string | undefined) =>
  typeof description !== "string" || description.trim().length === 0;

const rejectEmptyDescription = () => ({
  code: "MISSING_DESCRIPTION",
  message: "Issue description cannot be empty.",
});

const init: ExtensionInit = (fp) => {
  fp.on("issue:creating", ({ issue }) => {
    if (!hasEmptyDescription(issue.description)) {
      return undefined;
    }

    for (const line of GUIDANCE) {
      fp.log.warn(line);
    }

    return rejectEmptyDescription();
  });

  fp.on("issue:updating", ({ updates }) => {
    if (updates.description === undefined || !hasEmptyDescription(updates.description)) {
      return undefined;
    }

    for (const line of GUIDANCE) {
      fp.log.warn(line);
    }

    return rejectEmptyDescription();
  });
};

export default init;
