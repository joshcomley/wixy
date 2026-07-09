// Editor overlay entrypoint — injected into the preview iframe by
// `wixy_server.preview.render_preview_page` (spec/05-editor.md).
import { initOverlay } from "./overlay";

export function main(): void {
  initOverlay();
}

main();
