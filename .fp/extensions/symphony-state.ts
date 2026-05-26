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
 *   docs/architecture/fp-boundary.md
 *   docs/architecture/0001-symphony-deviations.md
 */
const textProperties = [
  ["symphony_attempt", "Symphony Attempt", "hash"],
  ["symphony_last_error", "Symphony Last Error", "alert-triangle"],
  ["symphony_branch", "Symphony Branch", "git-branch"],
  ["symphony_pr_url", "Symphony PR URL", "github"],
  ["symphony_pr_number", "Symphony PR Number", "hash"],
  ["symphony_base_sha", "Symphony Base SHA", "git-commit"],
  ["symphony_head_sha", "Symphony Head SHA", "git-commit"],
  ["symphony_run_id", "Symphony Run ID", "fingerprint"],
  ["symphony_sandbox_id", "Symphony Sandbox ID", "box"],
] as const;

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

  for (const [key, label, icon] of textProperties) {
    await fp.issues.registerProperty(key, {
      label,
      icon,
      display: fp.ui.properties.text(),
    });
  }

  // Mirrors the observability hook from references/brettimus-symphony/.fp/extensions/symphony-state.ts.
  // Useful when watching `fp` activity in a terminal during demos.
  fp.on("issue:status:changed", ({ issue, from, to }) => {
    fp.log.info(`[symphony-state] ${issue.id} status: ${from} -> ${to}`);
  });
};

export default init;
