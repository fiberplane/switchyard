import type { ExtensionInit } from "@fiberplane/extensions";

/**
 * Registers Symphony orchestration properties on issues.
 *
 * symphony_state is a coarse human-glance mirror of the orchestrator's
 * in-memory claim/run state. It is intentionally non-authoritative —
 * eligibility, dispatch, and retry decisions all operate on built-in
 * `status` and the orchestrator's in-memory running set, not on
 * symphony_state.
 *
 * See:
 *   docs/superpowers/specs/2026-05-04-symphony-daytona-vertical-slice.md
 *   docs/architecture/0001-symphony-deviations.md
 */
const init: ExtensionInit = async (fp) => {
  await fp.issues.registerProperty("symphony_ready", {
    label: "Ready for Symphony",
    icon: "check-circle",
    display: fp.ui.properties.select(
      fp.ui.properties.option("true", {
        label: "Ready",
        icon: "circle-check",
        color: "success",
      }),
      fp.ui.properties.option("false", {
        label: "Not Ready",
        icon: "circle-x",
        color: "neutral",
      }),
    ),
  });

  await fp.issues.registerProperty("symphony_state", {
    label: "Symphony State",
    icon: "activity",
    display: fp.ui.properties.select(
      fp.ui.properties.option("idle", {
        label: "Idle",
        icon: "circle",
        color: "neutral",
      }),
      fp.ui.properties.option("active", {
        label: "Active",
        icon: "loader",
        color: "blue",
      }),
      fp.ui.properties.option("end", {
        label: "End",
        icon: "circle-check",
        color: "success",
      }),
      fp.ui.properties.option("needs-attention", {
        label: "Needs Attention",
        icon: "alert-circle",
        color: "destructive",
      }),
    ),
  });

  await fp.issues.registerProperty("symphony_attempt", {
    label: "Symphony Attempt",
    icon: "hash",
    display: fp.ui.properties.text(),
  });

  await fp.issues.registerProperty("symphony_artifact", {
    label: "Symphony Artifact",
    icon: "git-branch",
    display: fp.ui.properties.text(),
  });

  await fp.issues.registerProperty("symphony_last_error", {
    label: "Symphony Last Error",
    icon: "alert-triangle",
    display: fp.ui.properties.text(),
  });

  // Mirrors the observability hook from references/brettimus-symphony/.fp/extensions/symphony-state.ts.
  // Useful when watching `fp` activity in a terminal during demos.
  fp.on("issue:status:changed", ({ issue, from, to }) => {
    fp.log.info(`[symphony-state] ${issue.id} status: ${from} -> ${to}`);
  });
};

export default init;
