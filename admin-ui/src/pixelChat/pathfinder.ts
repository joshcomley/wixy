// Pathfinder and trajectory generator for the pixel art characters
// Computes movement waypoints along chat blocks with overhangs (crawling/monkey-bar traversal),
// walking tops of blocks, crawling through gaps, and meeting smoothly at the middle block.

import type { FacingDirection, PixelRect, Waypoint } from "./types";

export interface TrajectoryPlan {
  side: "right" | "left";
  blocks: PixelRect[];
  meetingBlockIndex: number;
  meetingPoint: { x: number; y: number };
  platformRect: { x: number; y: number; width: number; height: number };
  guyWaypoints: Waypoint[];
  womanWaypoints: Waypoint[];
}

/** Extract visible chat bubble rectangles from the chat thread DOM element */
export function extractBubbleRects(threadEl: HTMLElement): PixelRect[] {
  const bubbles = Array.from(threadEl.querySelectorAll<HTMLElement>(".wx-chat-bubble"));
  if (bubbles.length === 0) return [];

  const threadRect = threadEl.getBoundingClientRect();
  const scrollTop = threadEl.scrollTop;
  const scrollLeft = threadEl.scrollLeft;

  const rects: PixelRect[] = [];
  for (const b of bubbles) {
    const r = b.getBoundingClientRect();
    // Position relative to thread's scrollable canvas area
    const x = r.left - threadRect.left + scrollLeft;
    const y = r.top - threadRect.top + scrollTop;
    if (r.width > 20 && r.height > 10) {
      rects.push({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    }
  }
  return rects;
}

/** Create fallback synthetic blocks to ensure a rich climbing scene across both sides */
export function createSyntheticBlocks(containerWidth: number, containerHeight: number): PixelRect[] {
  const w = Math.max(containerWidth, 400);
  const h = Math.max(containerHeight, 500);

  const blockHeight = 52;
  const gap = 30;
  const count = 4;
  const totalH = count * blockHeight + (count - 1) * gap;
  const startY = Math.max(24, Math.floor((h - totalH) / 2));

  // Alternating blocks that cross the middle so characters crawl across and underneath:
  // Block 0 (top): Assistant (left)
  // Block 1: User (right, extends far across to the left)
  // Block 2: Assistant (left, extends far across to the right)
  // Block 3 (bottom): User (right)
  const b0: PixelRect = { x: 24, y: startY, width: 280, height: blockHeight };
  const b1: PixelRect = {
    x: Math.max(80, w - 360),
    y: startY + blockHeight + gap,
    width: 336,
    height: blockHeight,
  };
  const b2: PixelRect = {
    x: 24,
    y: startY + (blockHeight + gap) * 2,
    width: 320,
    height: blockHeight,
  };
  const b3: PixelRect = {
    x: Math.max(120, w - 280),
    y: startY + (blockHeight + gap) * 3,
    width: 256,
    height: blockHeight,
  };

  return [b0, b1, b2, b3];
}

/**
 * Generate complete trajectory plan for both characters.
 * Guy climbs UP from bottom.
 * Woman climbs DOWN from top.
 * They traverse both user and assistant blocks, crawl under overhangs, walk tops,
 * and meet cleanly at the middle block without either overshooting.
 */
export function buildTrajectoryPlan(
  containerWidth: number,
  containerHeight: number,
  extractedBlocks: PixelRect[],
): TrajectoryPlan {
  let blocks: PixelRect[] = [];

  if (extractedBlocks.length >= 2) {
    // Preserve all blocks (both user and assistant) sorted by vertical position
    blocks = [...extractedBlocks].sort((a, b) => a.y - b.y);
  }

  // Fallback to rich synthetic blocks if sparse
  if (blocks.length < 3) {
    blocks = createSyntheticBlocks(containerWidth, containerHeight);
  }

  const n = blocks.length;
  const meetingIdx = Math.floor(n / 2);
  const meetingBlock = blocks[meetingIdx] ?? blocks[0]!;

  // Platform details:
  // Wooden platform scrolls out to the left from the meeting block
  const platformWidth = 120;
  const platformHeight = 14;

  // The meeting block's inner/left edge provides the anchor wall
  const isRightSide = meetingBlock.x + meetingBlock.width * 0.5 > containerWidth * 0.4;
  const anchorX = isRightSide ? meetingBlock.x : Math.min(containerWidth - 24, meetingBlock.x + meetingBlock.width);
  const platformY = meetingBlock.y + Math.floor(meetingBlock.height / 2);

  const meetingPoint = {
    x: anchorX,
    y: platformY,
  };

  const platformRect = {
    x: anchorX - platformWidth,
    y: platformY,
    width: platformWidth,
    height: platformHeight,
  };

  const side: "right" | "left" = isRightSide ? "right" : "left";

  // Helper to determine if a block is anchored on the right side
  function isRight(b: PixelRect): boolean {
    return b.x + b.width * 0.5 > containerWidth * 0.45;
  }

  function getInnerEdgeX(b: PixelRect): number {
    return isRight(b) ? b.x : b.x + b.width;
  }

  // --- GUY TRAJECTORY (Climbing UP from bottom to meetingIdx) ---
  const guyWaypoints: Waypoint[] = [];
  const lowestBlock = blocks[n - 1]!;
  const lowestInnerX = getInnerEdgeX(lowestBlock);

  // 1. Appear from bottom - Guy climbs UP from below
  const startGuyX = lowestInnerX;
  const startGuyY = Math.min(containerHeight + 40, lowestBlock.y + lowestBlock.height + 40);

  guyWaypoints.push({
    x: startGuyX,
    y: startGuyY,
    state: "climb_up",
    facing: isRight(lowestBlock) ? "right" : "left",
  });

  // Climb up to bottom edge of lowest block
  guyWaypoints.push({
    x: lowestInnerX,
    y: lowestBlock.y + lowestBlock.height,
    state: "climb_up",
    facing: isRight(lowestBlock) ? "right" : "left",
  });

  // Navigate up from lowest block (n-1) to meetingIdx
  for (let i = n - 1; i >= meetingIdx; i--) {
    const cur = blocks[i]!;
    const curInnerX = getInnerEdgeX(cur);
    const facingSide: FacingDirection = isRight(cur) ? "right" : "left";

    if (i === meetingIdx) {
      // Reached meeting block! Climb up to meetingPoint.y and STOP
      // (Never overshoot the girl!)
      guyWaypoints.push({
        x: meetingPoint.x,
        y: meetingPoint.y,
        state: "climb_up",
        facing: isRight(cur) ? "right" : "left",
      });
      break;
    }

    // Climb up vertical edge of current block to its top edge
    guyWaypoints.push({
      x: curInnerX,
      y: cur.y,
      state: "climb_up",
      facing: facingSide,
    });

    const nextUp = blocks[i - 1]!;
    const nextInnerX = getInnerEdgeX(nextUp);
    const undersideY = nextUp.y + nextUp.height;

    // Check relationship with block above
    if (isRight(cur) && isRight(nextUp)) {
      if (nextUp.x < cur.x) {
        // Overhang above! Crawl underneath nextUp
        guyWaypoints.push({
          x: cur.x,
          y: undersideY,
          state: "crawl",
          facing: "left",
        });
        // Wrap around corner and climb up nextUp
        guyWaypoints.push({
          x: nextUp.x,
          y: undersideY,
          state: "climb_up",
          facing: "left",
        });
      } else {
        // Step-in: walk across top of cur to nextUp base
        guyWaypoints.push({
          x: nextUp.x,
          y: cur.y,
          state: "walk_top",
          facing: "right",
        });
        guyWaypoints.push({
          x: nextUp.x,
          y: cur.y,
          state: "climb_up",
          facing: "left",
        });
      }
    } else if (!isRight(cur) && !isRight(nextUp)) {
      const curRight = cur.x + cur.width;
      const nextRight = nextUp.x + nextUp.width;
      if (nextRight > curRight) {
        // Overhang to the right
        guyWaypoints.push({
          x: curRight,
          y: undersideY,
          state: "crawl",
          facing: "right",
        });
        guyWaypoints.push({
          x: nextRight,
          y: undersideY,
          state: "climb_up",
          facing: "right",
        });
      } else {
        // Step-in to the left
        guyWaypoints.push({
          x: nextRight,
          y: cur.y,
          state: "walk_top",
          facing: "left",
        });
        guyWaypoints.push({
          x: nextRight,
          y: cur.y,
          state: "climb_up",
          facing: "right",
        });
      }
    } else {
      // Opposite sides (crossing between user and assistant blocks)
      const overlapsHorizontally =
        isRight(cur)
          ? nextUp.x + nextUp.width >= cur.x - 20
          : cur.x + cur.width >= nextUp.x - 20;

      if (overlapsHorizontally) {
        // Crawl underneath the block that spans across
        guyWaypoints.push({
          x: curInnerX,
          y: undersideY,
          state: "crawl",
          facing: nextInnerX < curInnerX ? "left" : "right",
        });
        guyWaypoints.push({
          x: nextInnerX,
          y: undersideY,
          state: "climb_up",
          facing: isRight(nextUp) ? "right" : "left",
        });
      } else {
        // Gap between blocks: leap across to next block underside
        guyWaypoints.push({
          x: curInnerX,
          y: cur.y,
          state: "jump",
          facing: nextInnerX < curInnerX ? "left" : "right",
        });
        guyWaypoints.push({
          x: nextInnerX,
          y: undersideY,
          state: "climb_up",
          facing: isRight(nextUp) ? "right" : "left",
        });
      }
    }
  }

  // --- WOMAN TRAJECTORY (Climbing DOWN from top to meetingIdx) ---
  const womanWaypoints: Waypoint[] = [];
  const highestBlock = blocks[0]!;
  const highestInnerX = getInnerEdgeX(highestBlock);

  // 1. Appear from top - Woman climbs DOWN from above
  const startWomanX = highestInnerX;
  const startWomanY = Math.max(-40, highestBlock.y - 40);

  womanWaypoints.push({
    x: startWomanX,
    y: startWomanY,
    state: "climb_down",
    facing: isRight(highestBlock) ? "right" : "left",
  });

  // Climb down to top edge of highest block
  womanWaypoints.push({
    x: highestInnerX,
    y: highestBlock.y,
    state: "climb_down",
    facing: isRight(highestBlock) ? "right" : "left",
  });

  // Navigate down from top block (0) to meetingIdx
  for (let i = 0; i <= meetingIdx; i++) {
    const cur = blocks[i]!;
    const curInnerX = getInnerEdgeX(cur);
    const facingSide: FacingDirection = isRight(cur) ? "right" : "left";

    if (i === meetingIdx) {
      // Reached meeting block! Climb down to meetingPoint.y and STOP
      womanWaypoints.push({
        x: meetingPoint.x,
        y: meetingPoint.y,
        state: "climb_down",
        facing: isRight(cur) ? "right" : "left",
      });
      break;
    }

    // Climb down vertical side to bottom corner
    womanWaypoints.push({
      x: curInnerX,
      y: cur.y + cur.height,
      state: "climb_down",
      facing: facingSide,
    });

    const nextDown = blocks[i + 1]!;
    const nextInnerX = getInnerEdgeX(nextDown);

    if (isRight(cur) && isRight(nextDown)) {
      if (nextDown.x < cur.x) {
        // Next block down extends further out: drop down and walk across
        womanWaypoints.push({
          x: cur.x,
          y: nextDown.y,
          state: "walk_top",
          facing: "left",
        });
        womanWaypoints.push({
          x: nextDown.x,
          y: nextDown.y,
          state: "climb_down",
          facing: "left",
        });
      } else {
        // Current block overhangs: crawl along bottom edge
        womanWaypoints.push({
          x: nextDown.x,
          y: cur.y + cur.height,
          state: "crawl",
          facing: "right",
        });
        womanWaypoints.push({
          x: nextDown.x,
          y: nextDown.y,
          state: "climb_down",
          facing: "left",
        });
      }
    } else {
      // Across opposite blocks: leap across gap to next block top
      womanWaypoints.push({
        x: curInnerX,
        y: cur.y + cur.height,
        state: "jump",
        facing: nextInnerX < curInnerX ? "left" : "right",
      });
      womanWaypoints.push({
        x: nextInnerX,
        y: nextDown.y,
        state: "climb_down",
        facing: isRight(nextDown) ? "right" : "left",
      });
    }
  }

  return {
    side,
    blocks,
    meetingBlockIndex: meetingIdx,
    meetingPoint,
    platformRect,
    guyWaypoints,
    womanWaypoints,
  };
}
