// Pathfinder and trajectory generator for the pixel art characters
// Computes movement waypoints along chat blocks with overhangs (monkey-bar traversal)
// and step-ins (top-of-block walking).

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

/** Create fallback synthetic blocks to ensure a rich climbing scene even in empty or small chats */
export function createSyntheticBlocks(containerWidth: number, containerHeight: number): PixelRect[] {
  const w = Math.max(containerWidth, 400);
  const h = Math.max(containerHeight, 500);

  const blockHeight = 60;
  const gap = 30;
  const count = 4;
  const totalH = count * blockHeight + (count - 1) * gap;
  const startY = Math.max(20, (h - totalH) / 2);

  // Varying widths to guarantee both overhangs and step-ins:
  // Bottom block (0): width 240
  // Next block up (1): width 340 (OVERHANG! Next extends further out left)
  // Next block up (2): width 200 (STEP-IN! Current extends further out left than next)
  // Top block (3): width 280 (OVERHANG!)
  const widths = [240, 340, 200, 280];

  const blocks: PixelRect[] = [];
  for (let i = 0; i < count; i++) {
    const bw = widths[i] ?? 240;
    const by = startY + (count - 1 - i) * (blockHeight + gap);
    const bx = w - 24 - bw;
    blocks.push({ x: bx, y: by, width: bw, height: blockHeight });
  }
  // Sort top-to-bottom by y ascending
  blocks.sort((a, b) => a.y - b.y);
  return blocks;
}

/**
 * Generate complete trajectory plan for both characters.
 * Guy climbs UP from bottom.
 * Woman climbs DOWN from top.
 * They meet at the middle block, where the platform scrolls out.
 */
export function buildTrajectoryPlan(
  containerWidth: number,
  containerHeight: number,
  extractedBlocks: PixelRect[],
): TrajectoryPlan {
  let blocks: PixelRect[] = [];

  // Filter or augment blocks
  if (extractedBlocks.length >= 3) {
    // Check if right-aligned or left-aligned
    const rightSide = extractedBlocks.filter((b) => b.x + b.width > containerWidth * 0.5);
    if (rightSide.length >= 2) {
      blocks = [...rightSide].sort((a, b) => a.y - b.y);
    } else {
      blocks = [...extractedBlocks].sort((a, b) => a.y - b.y);
    }
  }

  // If fewer than 3 blocks or lack of width variation, use synthetic blocks
  if (blocks.length < 3) {
    blocks = createSyntheticBlocks(containerWidth, containerHeight);
  }

  const side: "right" | "left" = "right"; // Right-aligned bubbles (user messages)
  const n = blocks.length;
  const meetingIdx = Math.floor(n / 2);
  const meetingBlock = blocks[meetingIdx] ?? blocks[0]!;

  // Platform details
  const platformWidth = 120;
  const platformHeight = 14;
  // Platform scrolls out to the left of the meeting block
  const platformX = Math.max(16, meetingBlock.x - platformWidth - 20);
  const platformY = meetingBlock.y + Math.floor(meetingBlock.height / 2);

  const meetingPoint = {
    x: meetingBlock.x,
    y: platformY,
  };

  // --- GUY TRAJECTORY (Climbing UP from bottom to meetingIdx) ---
  const guyWaypoints: Waypoint[] = [];
  const lowestBlock = blocks[n - 1]!;

  // 1. Appear from bottom
  const startGuyX = lowestBlock.x;
  const startGuyY = Math.min(containerHeight + 40, lowestBlock.y + lowestBlock.height + 40);

  guyWaypoints.push({
    x: startGuyX,
    y: startGuyY,
    state: "appear",
    facing: "left",
  });

  // Climb up to bottom edge of lowest block
  guyWaypoints.push({
    x: lowestBlock.x,
    y: lowestBlock.y + lowestBlock.height,
    state: "climb_up",
    facing: "left",
  });

  // Navigate up from lowest block (n-1) to meetingIdx
  for (let i = n - 1; i >= meetingIdx; i--) {
    const current = blocks[i]!;

    // Climb up the vertical side of current block
    guyWaypoints.push({
      x: current.x,
      y: current.y, // At top-left corner
      state: "climb_up",
      facing: "left",
    });

    if (i > meetingIdx) {
      const nextUp = blocks[i - 1]!;
      // Compare horizontal extent of current vs nextUp
      // Note: for right-aligned bubbles, smaller x means sticking out FURTHER left
      if (nextUp.x < current.x) {
        // OVERHANG! Next block extends further left than current block
        // Guy stretches arms up, grabs underside of next block, and monkey-bar shimmies left!
        // 1. Reach up to underside of nextUp
        const undersideY = nextUp.y + nextUp.height;
        guyWaypoints.push({
          x: current.x,
          y: undersideY,
          state: "hang_traverse",
          facing: "left",
        });
        // 2. Monkey-bar shimmy across underside to outer edge of nextUp
        guyWaypoints.push({
          x: nextUp.x,
          y: undersideY,
          state: "hang_traverse",
          facing: "left",
        });
        // 3. Now positioned at bottom-left corner of nextUp, ready to climb up its side
      } else {
        // STEP-IN! Current block extends further left than nextUp
        // Guy climbs onto top surface of current, walks right across top surface to nextUp!
        // 1. Walk across top of current to x of nextUp
        guyWaypoints.push({
          x: nextUp.x,
          y: current.y,
          state: "walk_top",
          facing: "right",
        });
        // 2. Step to base of nextUp
        guyWaypoints.push({
          x: nextUp.x,
          y: nextUp.y + nextUp.height,
          state: "climb_up",
          facing: "left",
        });
      }
    }
  }

  // --- WOMAN TRAJECTORY (Climbing DOWN from top to meetingIdx) ---
  const womanWaypoints: Waypoint[] = [];
  const highestBlock = blocks[0]!;

  // 1. Appear from top
  const startWomanX = highestBlock.x;
  const startWomanY = Math.max(-40, highestBlock.y - 40);

  womanWaypoints.push({
    x: startWomanX,
    y: startWomanY,
    state: "appear",
    facing: "left",
  });

  // Climb down to top edge of highest block
  womanWaypoints.push({
    x: highestBlock.x,
    y: highestBlock.y,
    state: "climb_down",
    facing: "left",
  });

  // Navigate down from top block (0) to meetingIdx
  for (let i = 0; i <= meetingIdx; i++) {
    const current = blocks[i]!;

    if (i < meetingIdx) {
      const nextDown = blocks[i + 1]!;

      // Climb down vertical side of current block to its bottom corner
      womanWaypoints.push({
        x: current.x,
        y: current.y + current.height,
        state: "climb_down",
        facing: "left",
      });

      // Compare horizontal extent of current vs nextDown
      if (nextDown.x < current.x) {
        // Next block down extends further left (sticks out more)
        // Woman drops/climbs down to top surface of nextDown, then walks across top surface
        womanWaypoints.push({
          x: current.x,
          y: nextDown.y,
          state: "walk_top",
          facing: "left",
        });
        womanWaypoints.push({
          x: nextDown.x,
          y: nextDown.y,
          state: "walk_top",
          facing: "left",
        });
      } else {
        // Current block extends further left than nextDown (current is an overhang)
        // Woman hangs from bottom edge of current, shimmies across, then drops to nextDown
        womanWaypoints.push({
          x: nextDown.x,
          y: current.y + current.height,
          state: "hang_traverse",
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
      // Reached meeting block
      womanWaypoints.push({
        x: current.x,
        y: meetingPoint.y,
        state: "climb_down",
        facing: "left",
      });
    }
  }

  // Adjust guy's final arrival at meetingPoint
  guyWaypoints.push({
    x: meetingPoint.x,
    y: meetingPoint.y,
    state: "climb_up",
    facing: "left",
  });

  return {
    side,
    blocks,
    meetingBlockIndex: meetingIdx,
    meetingPoint,
    platformRect: {
      x: platformX,
      y: platformY,
      width: platformWidth,
      height: platformHeight,
    },
    guyWaypoints,
    womanWaypoints,
  };
}
