// Scene orchestrator and 60fps animation director for pixel chat interaction
// Coordinates traversal along chat blocks, platform scroll-out, jump, and cuddle.

import { buildTrajectoryPlan, extractBubbleRects, type TrajectoryPlan } from "./pathfinder";
import {
  drawCoupleCuddle,
  drawCoupleEmbrace,
  drawPixelMatrix,
  drawPixelPlatform,
  getSpriteMatrix,
  GUY_PALETTE,
  HEART_PALETTE,
  PIXEL_HEART,
  PIXEL_SCALE,
  WOMAN_PALETTE,
} from "./sprites";
import type { AnimationState, CharacterKind, CharacterMotion, FacingDirection, HeartParticle, PlatformState, Waypoint } from "./types";

export interface SceneController {
  start(): void;
  stop(): void;
  dismiss(onComplete?: () => void): void;
  reset(): void;
  isRunning(): boolean;
  setSpeed(multiplier: number): void;
}

export function createPixelChatScene(
  containerEl: HTMLElement,
  options?: {
    speedMultiplier?: number | undefined;
    onPhaseChange?: ((phase: string) => void) | undefined;
  },
): SceneController {
  const win = containerEl.ownerDocument.defaultView ?? window;
  const requestAnimationFrameFn =
    typeof win?.requestAnimationFrame === "function"
      ? win.requestAnimationFrame.bind(win)
      : (cb: FrameRequestCallback) => (globalThis.setTimeout(() => cb(Date.now()), 16) as unknown as number);
  const cancelAnimationFrameFn =
    typeof win?.cancelAnimationFrame === "function"
      ? win.cancelAnimationFrame.bind(win)
      : (id: number) => globalThis.clearTimeout(id);

  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let animId: number | null = null;

  let speed = options?.speedMultiplier ?? 1.0;
  let running = false;
  let dismissing = false;
  let dismissProgress = 0;
  let onDismissComplete: (() => void) | null = null;

  let plan: TrajectoryPlan | null = null;
  let guyWaypointIndex = 0;
  let guyProgress = 0; // 0 to 1 along current segment
  let womanWaypointIndex = 0;
  let womanProgress = 0;

  let guyMotion: CharacterMotion = {
    kind: "guy",
    x: 0,
    y: 0,
    state: "appear",
    facing: "left",
    frame: 0,
    alpha: 1.0,
  };

  let womanMotion: CharacterMotion = {
    kind: "woman",
    x: 0,
    y: 0,
    state: "appear",
    facing: "left",
    frame: 0,
    alpha: 1.0,
  };

  let platform: PlatformState = {
    visible: false,
    x: 0,
    y: 0,
    currentWidth: 0,
    targetWidth: 120,
    height: 14,
    scrollProgress: 0,
  };

  type Phase = "traversing" | "platform_deploy" | "embrace" | "jump" | "cuddle";
  let currentPhase: Phase = "traversing";
  let phaseTimerMs = 0;

  // Jump physics
  let jumpStart = { x: 0, y: 0 };
  let jumpTarget = { x: 0, y: 0 };
  let jumpProgress = 0; // 0 to 1

  const hearts: HeartParticle[] = [];
  let lastTime = 0;
  let frameTimer = 0;
  let heartTimer = 0;

  function ensureCanvas(): HTMLCanvasElement {
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "wx-pixel-chat-canvas";
      canvas.style.position = "absolute";
      canvas.style.top = "0";
      canvas.style.left = "0";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.pointerEvents = "none";
      canvas.style.zIndex = "10";
      containerEl.style.position = "relative";
      containerEl.appendChild(canvas);
      ctx = canvas.getContext("2d");
    }
    resizeCanvas();
    return canvas;
  }

  function resizeCanvas(): void {
    if (!canvas || !ctx) return;
    const rect = containerEl.getBoundingClientRect();
    const dpr = win.devicePixelRatio || 1;
    const w = Math.max(rect.width, 300);
    const h = Math.max(rect.height, 400);

    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
  }

  function spawnHeart(x: number, y: number): void {
    hearts.push({
      x: x + (Math.random() * 24 - 12),
      y: y + (Math.random() * 10 - 5),
      vx: (Math.random() - 0.5) * 20,
      vy: -(25 + Math.random() * 25),
      alpha: 1.0,
      size: 1.5 + Math.random() * 0.8,
      life: 0,
      maxLife: 1500 + Math.random() * 1000,
    });
  }

  function updateMotionAlongWaypoints(
    waypoints: Waypoint[],
    currentIndex: number,
    progress: number,
    motion: CharacterMotion,
    dtSeconds: number,
    moveSpeedPxPerSec: number,
  ): { nextIndex: number; nextProgress: number; reachedEnd: boolean } {
    if (currentIndex >= waypoints.length - 1) {
      const last = waypoints[waypoints.length - 1]!;
      motion.x = last.x;
      motion.y = last.y;
      motion.state = last.state;
      motion.facing = last.facing;
      return { nextIndex: currentIndex, nextProgress: 1, reachedEnd: true };
    }

    const p0 = waypoints[currentIndex]!;
    const p1 = waypoints[currentIndex + 1]!;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= 0.001) {
      return { nextIndex: currentIndex + 1, nextProgress: 0, reachedEnd: false };
    }

    const step = (moveSpeedPxPerSec * dtSeconds) / dist;
    let nextProgress = progress + step;
    let nextIndex = currentIndex;

    if (nextProgress >= 1) {
      nextIndex++;
      nextProgress = 0;
    }

    const currentP0 = waypoints[nextIndex] ?? p0;
    const currentP1 = waypoints[nextIndex + 1] ?? p1;
    const curDx = currentP1.x - currentP0.x;
    const curDy = currentP1.y - currentP0.y;

    motion.x = currentP0.x + curDx * nextProgress;
    motion.y = currentP0.y + curDy * nextProgress;
    motion.state = currentP0.state;
    motion.facing = currentP0.facing;

    const reachedEnd = nextIndex >= waypoints.length - 1;
    return { nextIndex, nextProgress, reachedEnd };
  }

  function setPhase(newPhase: Phase): void {
    currentPhase = newPhase;
    phaseTimerMs = 0;
    options?.onPhaseChange?.(newPhase);
  }

  function loop(timestamp: number): void {
    if (!running) return;
    if (lastTime === 0) lastTime = timestamp;
    const rawDt = Math.min((timestamp - lastTime) / 1000, 0.1);
    lastTime = timestamp;
    const dt = rawDt * speed;

    frameTimer += dt;
    if (frameTimer >= 0.14) {
      guyMotion.frame = (guyMotion.frame + 1) % 4;
      womanMotion.frame = (womanMotion.frame + 1) % 4;
      frameTimer = 0;
    }

    updateScene(dt);
    renderScene();

    if (dismissing) {
      dismissProgress += dt * 3.5;
      guyMotion.alpha = Math.max(0, 1 - dismissProgress);
      womanMotion.alpha = Math.max(0, 1 - dismissProgress);
      if (dismissProgress >= 1) {
        stop();
        onDismissComplete?.();
        return;
      }
    }

    animId = requestAnimationFrameFn(loop);
  }

  function updateScene(dt: number): void {
    if (!plan) return;
    phaseTimerMs += dt * 1000;

    const BASE_MOVE_SPEED = 75; // pixels per second

    switch (currentPhase) {
      case "traversing": {
        // Move both characters along their respective waypoints
        const guyResult = updateMotionAlongWaypoints(
          plan.guyWaypoints,
          guyWaypointIndex,
          guyProgress,
          guyMotion,
          dt,
          BASE_MOVE_SPEED,
        );
        guyWaypointIndex = guyResult.nextIndex;
        guyProgress = guyResult.nextProgress;

        const womanResult = updateMotionAlongWaypoints(
          plan.womanWaypoints,
          womanWaypointIndex,
          womanProgress,
          womanMotion,
          dt,
          BASE_MOVE_SPEED,
        );
        womanWaypointIndex = womanResult.nextIndex;
        womanProgress = womanResult.nextProgress;

        // When both reach meeting block
        if (guyResult.reachedEnd && womanResult.reachedEnd) {
          // Initialize platform deployment
          platform.visible = true;
          platform.x = plan.platformRect.x;
          platform.y = plan.platformRect.y;
          platform.targetWidth = plan.platformRect.width;
          platform.height = plan.platformRect.height;
          platform.currentWidth = 0;
          platform.scrollProgress = 0;
          setPhase("platform_deploy");
        }
        break;
      }

      case "platform_deploy": {
        // Platform smoothly scrolls out to the left
        platform.scrollProgress = Math.min(1, platform.scrollProgress + dt * 1.2);
        // Cubic ease out
        const t = platform.scrollProgress;
        const easeOut = 1 - Math.pow(1 - t, 3);
        platform.currentWidth = platform.targetWidth * easeOut;

        guyMotion.state = "climb_up";
        womanMotion.state = "climb_down";

        if (platform.scrollProgress >= 1) {
          setPhase("embrace");
        }
        break;
      }

      case "embrace": {
        // Both characters hold each other at the wall edge
        guyMotion.state = "embrace";
        womanMotion.state = "embrace";

        if (phaseTimerMs >= 1000) {
          // Prepare synchronized jump
          jumpStart = { x: plan.meetingPoint.x, y: plan.meetingPoint.y };
          // Land in middle of platform
          jumpTarget = {
            x: platform.x + platform.targetWidth * 0.45,
            y: platform.y - 4,
          };
          jumpProgress = 0;
          setPhase("jump");
        }
        break;
      }

      case "jump": {
        // Parabolic jump arc from wall to platform
        jumpProgress = Math.min(1, jumpProgress + dt * 1.5);
        const jp = jumpProgress;

        // Horizontal linear interpolation
        const currentX = jumpStart.x + (jumpTarget.x - jumpStart.x) * jp;

        // Vertical parabolic arc (jump peak ~30px)
        const peakHeight = 35;
        const arc = -4 * peakHeight * jp * (jp - 1); // standard parabola: 0 at jp=0 and jp=1, peak at jp=0.5
        const currentY = jumpStart.y + (jumpTarget.y - jumpStart.y) * jp - arc;

        guyMotion.x = currentX;
        guyMotion.y = currentY;
        guyMotion.state = "jump";
        guyMotion.facing = "left";

        womanMotion.x = currentX + 6;
        womanMotion.y = currentY;
        womanMotion.state = "jump";
        womanMotion.facing = "left";

        if (jumpProgress >= 1) {
          setPhase("cuddle");
        }
        break;
      }

      case "cuddle": {
        // Lying down side by side snuggled on the platform
        guyMotion.x = jumpTarget.x - 8;
        guyMotion.y = jumpTarget.y - 12;
        guyMotion.state = "cuddle";

        womanMotion.x = jumpTarget.x - 8;
        womanMotion.y = jumpTarget.y - 12;
        womanMotion.state = "cuddle";

        // Spawn gentle floating heart particles
        heartTimer += dt;
        if (heartTimer >= 0.45) {
          heartTimer = 0;
          spawnHeart(guyMotion.x + 20, guyMotion.y);
        }
        break;
      }
    }

    // Update heart particles
    for (let i = hearts.length - 1; i >= 0; i--) {
      const h = hearts[i]!;
      h.life += dt * 1000;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.alpha = Math.max(0, 1 - h.life / h.maxLife);
      if (h.life >= h.maxLife) {
        hearts.splice(i, 1);
      }
    }
  }

  function renderScene(): void {
    if (!canvas || !ctx || !plan) return;
    const dpr = win.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;

    // 1. Draw platform if deployed
    if (platform.visible && platform.currentWidth > 0) {
      // Platform scrolls out from wall (right to left):
      // right anchor is at plan.meetingPoint.x
      const drawX = plan.meetingPoint.x - platform.currentWidth;
      drawPixelPlatform(ctx, drawX, platform.y, platform.currentWidth, platform.height, PIXEL_SCALE);
    }

    // 2. Draw characters
    if (currentPhase === "cuddle") {
      // Draw pair cuddling together
      drawCoupleCuddle(ctx, guyMotion.x, guyMotion.y, PIXEL_SCALE, guyMotion.alpha);
    } else if (currentPhase === "embrace") {
      drawCoupleEmbrace(ctx, plan.meetingPoint.x - 14, plan.meetingPoint.y - 20, PIXEL_SCALE, guyMotion.alpha);
    } else {
      // Draw individual characters
      const guyMatrix = getSpriteMatrix("guy", guyMotion.state, guyMotion.frame);
      const womanMatrix = getSpriteMatrix("woman", womanMotion.state, womanMotion.frame);

      // Guy
      drawPixelMatrix(
        ctx,
        guyMatrix,
        GUY_PALETTE,
        Math.round(guyMotion.x - 12),
        Math.round(guyMotion.y - 24),
        PIXEL_SCALE,
        guyMotion.facing === "right",
        guyMotion.alpha,
      );

      // Woman
      drawPixelMatrix(
        ctx,
        womanMatrix,
        WOMAN_PALETTE,
        Math.round(womanMotion.x - 12),
        Math.round(womanMotion.y - 24),
        PIXEL_SCALE,
        womanMotion.facing === "right",
        womanMotion.alpha,
      );
    }

    // 3. Draw floating hearts
    for (const heart of hearts) {
      drawPixelMatrix(
        ctx,
        PIXEL_HEART,
        HEART_PALETTE,
        Math.round(heart.x),
        Math.round(heart.y),
        heart.size,
        false,
        heart.alpha * guyMotion.alpha,
      );
    }

    ctx.restore();
  }

  function start(): void {
    if (running) return;
    ensureCanvas();
    const rect = containerEl.getBoundingClientRect();
    const extracted = extractBubbleRects(containerEl);
    plan = buildTrajectoryPlan(rect.width, rect.height, extracted);

    guyWaypointIndex = 0;
    guyProgress = 0;
    womanWaypointIndex = 0;
    womanProgress = 0;

    dismissing = false;
    dismissProgress = 0;
    guyMotion.alpha = 1.0;
    womanMotion.alpha = 1.0;

    platform.visible = false;
    platform.currentWidth = 0;
    platform.scrollProgress = 0;
    hearts.length = 0;

    setPhase("traversing");
    running = true;
    lastTime = 0;
    animId = requestAnimationFrameFn(loop);
  }

  function stop(): void {
    running = false;
    if (animId !== null) {
      cancelAnimationFrameFn(animId);
      animId = null;
    }
    if (canvas && ctx) {
      const dpr = win.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    }
  }

  function dismiss(onComplete?: () => void): void {
    if (!running || dismissing) {
      onComplete?.();
      return;
    }
    dismissing = true;
    dismissProgress = 0;
    onDismissComplete = onComplete ?? null;
    guyMotion.state = "scamper";
    womanMotion.state = "scamper";
  }

  function reset(): void {
    stop();
    hearts.length = 0;
  }

  return {
    start,
    stop,
    dismiss,
    reset,
    isRunning(): boolean {
      return running;
    },
    setSpeed(mult: number): void {
      speed = Math.max(0.1, mult);
    },
  };
}
