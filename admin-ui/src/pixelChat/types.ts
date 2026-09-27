// Types for the pixel art chat interaction (idle animation)
// Guy in pink suit & woman in blue dress scaling chat blocks,
// monkey-bar traversing overhangs, meeting on a scrolling platform, and cuddling.

export type CharacterKind = "guy" | "woman";

export type AnimationState =
  | "appear"
  | "climb_up"
  | "climb_down"
  | "walk_top"
  | "hang_traverse" // Monkey-bar ledge traverse with dangling legs
  | "crawl" // Hands and knees crawling under overhangs and through gaps
  | "embrace"
  | "jump"
  | "cuddle"
  | "scamper"
  | "stumble"
  | "slide_fall";

export type FacingDirection = "left" | "right";

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Waypoint {
  x: number;
  y: number;
  state: AnimationState;
  facing: FacingDirection;
  speedMultiplier?: number;
}

export interface CharacterMotion {
  kind: CharacterKind;
  x: number;
  y: number;
  state: AnimationState;
  facing: FacingDirection;
  frame: number;
  alpha: number;
}

export interface PlatformState {
  visible: boolean;
  x: number;
  y: number;
  currentWidth: number;
  targetWidth: number;
  height: number;
  scrollProgress: number; // 0 to 1
}

export interface HeartParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
  size: number;
  life: number;
  maxLife: number;
}

export interface SceneStage {
  phase:
    | "traversing"
    | "platform_deploy"
    | "embrace"
    | "jump"
    | "cuddle"
    | "stumble_fall"
    | "platform_collapse"
    | "dismissing"
    | "idle_waiting";
  progress: number;
}

export interface PixelChatController {
  triggerNow(): void;
  reset(): void;
  teardown(): void;
  isAnimating(): boolean;
  getTimeUntilIdleMs(): number;
  interrupt(reason?: "message" | "activity"): void;
  onIncomingMessage(): void;
}

export interface PixelChatOptions {
  idleTimeoutMs?: number | undefined; // default 30_000 (30 seconds)
  debugAlwaysActive?: boolean | undefined;
  win?: Window | undefined;
  onStateChange?: ((state: string) => void) | undefined;
}
