import type { ExtensionInit } from "@fiberplane/extensions";

const GUIDANCE = [
  "Issue descriptions should stay empty in this repo.",
  "",
  "Put durable context, findings, and implementation notes in comments instead.",
  "This keeps the issue body stable and makes new knowledge append-only.",
  "",
  "Use:",
  '  fp comment add <issue-id> "<notes>"',
];

const hasNonEmptyDescription = (description: string | undefined) =>
  typeof description === "string" && description.trim().length > 0;

const init: ExtensionInit = (fp) => {
  fp.on("issue:creating", ({ issue }) => {
    if (!hasNonEmptyDescription(issue.description)) {
      return undefined;
    }

    for (const line of GUIDANCE) {
      fp.log.warn(line);
    }

    return {
      code: "DESCRIPTION_NOT_ALLOWED",
      message: "Issue descriptions must be empty. Put context in comments instead.",
    };
  });

  fp.on("issue:updating", ({ updates }) => {
    if (!hasNonEmptyDescription(updates.description)) {
      return undefined;
    }

    for (const line of GUIDANCE) {
      fp.log.warn(line);
    }

    return {
      code: "DESCRIPTION_NOT_ALLOWED",
      message: "Issue descriptions must be empty. Put context in comments instead.",
    };
  });
};

export default init;
