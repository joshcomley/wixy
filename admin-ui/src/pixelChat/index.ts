// Public entry point for the pixel art chat interaction
export * from "./types";
export * from "./sprites";
export * from "./pathfinder";
export * from "./scene";
export * from "./idleWatchdog";

import { mountIdleWatchdog } from "./idleWatchdog";
import { createPixelChatScene } from "./scene";
import type { PixelChatController, PixelChatOptions } from "./types";

/**
 * Mount pixel art idle interaction onto a chat container element.
 * Attaches a 30s idle listener that triggers the climbing/cuddling animation.
 */
export function mountPixelChat(
  containerEl: HTMLElement,
  options?: PixelChatOptions,
): PixelChatController {
  const scene = createPixelChatScene(containerEl, {
    onPhaseChange: options?.onStateChange,
  });

  return mountIdleWatchdog(containerEl, scene, options);
}
