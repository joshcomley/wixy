// Layman publish-stage narration (decisions/00089's original wording,
// decisions/00095's shared home) — shell.ts's status-bar chip and
// publishDrawer.ts's own running-state caption both narrate the SAME job, so
// they must never drift on wording. Split out of shell.ts specifically so the
// drawer can import it without an import cycle (shell.ts already imports
// mountPublishDrawer).

import type { PublishStage } from "./api";

export const PUBLISH_STAGE_LABELS: Record<PublishStage, string> = {
  pulling: "Getting the latest site…",
  merging: "Applying your changes…",
  committing: "Saving a new version…",
  building: "Building the site…",
  verifying: "Checking the site…",
  swapping: "Taking it live…",
  done: "Live.",
  failed: "Publish failed.",
};
