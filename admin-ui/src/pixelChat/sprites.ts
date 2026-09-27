// Pixel art sprites for guy in pink suit and woman in blue dress
// Rendered on HTML5 canvas using crisp integer-scale pixel rendering.

import type { AnimationState, CharacterKind, FacingDirection } from "./types";

export const PIXEL_SCALE = 2; // Each sprite pixel is 2x2 physical pixels (or scaled by DPR)

// Color palettes
export const GUY_PALETTE: Record<string, string> = {
  ".": "transparent",
  H: "#1e293b", // Hair (dark slate)
  F: "#fed7aa", // Face/skin (warm peach)
  E: "#0f172a", // Eyes
  P: "#ec4899", // Pink suit (primary)
  L: "#f472b6", // Pink suit (highlight/lapel)
  D: "#be185d", // Pink suit (dark shadow)
  W: "#ffffff", // White shirt collar
  T: "#0f172a", // Tie
  S: "#334155", // Shoes
  B: "#f43f5e", // Blush
};

export const WOMAN_PALETTE: Record<string, string> = {
  ".": "transparent",
  H: "#b45309", // Hair (warm golden auburn)
  F: "#fed7aa", // Face/skin
  E: "#0f172a", // Eyes
  C: "#0284c7", // Blue dress (primary royal blue)
  L: "#38bdf8", // Blue dress (highlight sky blue)
  D: "#0369a1", // Blue dress (shadow)
  W: "#e0f2fe", // Lace / trim
  S: "#1e293b", // Shoes
  B: "#f43f5e", // Blush
};

export const PLATFORM_PALETTE: Record<string, string> = {
  ".": "transparent",
  W: "#d97706", // Wood plank light
  M: "#b45309", // Wood plank medium
  D: "#78350f", // Wood plank dark shadow
  I: "#64748b", // Metal bracket / rivet
  K: "#334155", // Dark metal outline
};

export const HEART_PALETTE: Record<string, string> = {
  ".": "transparent",
  R: "#f43f5e", // Bright rose red
  H: "#fb7185", // Highlight pink
  D: "#e11d48", // Dark red
};

// 12 wide x 18 high pixel matrix templates

// --- GUY POSES ---
const GUY_STAND_1 = [
  "....HHHH....",
  "...HHHHHH...",
  "...SSFFSS...",
  "...SFFFFS...",
  "....SSSS....",
  "...PPPPPP...",
  "..PPWWWWPP..",
  "..PPPTTPPP..",
  "..PPPPPPPP..",
  "...PPPPPP...",
  "...PPPPPP...",
  "...PP..PP...",
  "...PP..PP...",
  "...PP..PP...",
  "...SS..SS...",
];

const GUY_WALK_1 = [
  "....HHHH....",
  "...HHHHHH...",
  "...EEFFEE...",
  "...EFFFFE...",
  "....FFFF....",
  "...LLPPLL...",
  "..LPPWPPPD..",
  "..PPPTPPD...",
  "...PPPPPD...",
  "...DPPPPD...",
  "...PPPPPP...",
  "...PP..PP...",
  "..PP....PP..",
  "..PP....PP..",
  ".SS......SS.",
];

const GUY_WALK_2 = [
  "....HHHH....",
  "...HHHHHH...",
  "...EEFFEE...",
  "...EFFFFE...",
  "....FFFF....",
  "...LLPPLL...",
  "..LPPWPPPD..",
  "..PPPTPPD...",
  "...PPPPPD...",
  "...DPPPPD...",
  "...PPPPPP...",
  "....PPPP....",
  "....PPPP....",
  "....PPPP....",
  "....SSSS....",
];

const GUY_CLIMB_1 = [
  "..FFHHHH....",
  ".FFFHHHHHH..",
  ".F..EEFFEE..",
  "....FFFF....",
  "..LLPPLLFF..",
  "..LPPWPPPP..",
  "...PPPTPPD..",
  "...PPPPPD...",
  "..DPPPPD....",
  "..PPPPPP....",
  "...PP..PP...",
  "..PP....PP..",
  "..SS.....SS.",
  "............",
  "............",
];

const GUY_CLIMB_2 = [
  "....HHHHFF..",
  "..HHHHHHFFF.",
  "..EEFFEE..F.",
  "....FFFF....",
  "..FFLLPPLL..",
  "..PPPWWPPD..",
  "...PPPTPPD..",
  "...PPPPPD...",
  "....DPPPPD..",
  "....PPPPPP..",
  "...PP..PP...",
  "..PP....PP..",
  ".SS......SS.",
  "............",
  "............",
];

// The iconic monkey-bar traversal: arms stretched UP, hands gripping ledge, legs dangling!
const GUY_HANG_1 = [
  "..FF....FF..", // Hands stretched straight up grabbing the ledge
  "..FF....FF..",
  "..LL....LL..", // Pink suit sleeves
  "...LLPPLL...",
  "...HHHHHH...", // Head looking up / forward
  "...EEFFEE...",
  "....FFFF....",
  "..LPPWPPPD..",
  "...PPPTPPD..",
  "...PPPPPD...",
  "...DPPPPD...",
  "....PPPP....", // Body dangling down
  "....PPPP....",
  "...PP..PP...", // Legs dangling & swinging left
  "..SS....SS..",
];

const GUY_HANG_2 = [
  "..FF....FF..", // Hands stretched up
  "..FF....FF..",
  "..LL....LL..",
  "...LLPPLL...",
  "...HHHHHH...",
  "...EEFFEE...",
  "....FFFF....",
  "..LPPWPPPD..",
  "...PPPTPPD..",
  "...PPPPPD...",
  "...DPPPPD...",
  "....PPPP....",
  "....PPPP....",
  ".....PPPP...", // Legs swinging right
  "......SSSS..",
];

const GUY_JUMP = [
  "..FF....FF..",
  "...HHHHHH...",
  "...EEFFEE...",
  "....FFFF....",
  "..LLPPLLDD..",
  ".LPPPWPPPDD.",
  ".LPPPPTPPDD.",
  "..PPPPPPPP..",
  "...PPPPPP...",
  "....PPPP....",
  "...PP..PP...",
  "..PP....PP..",
  ".SS......SS.",
  "............",
  "............",
];

// --- WOMAN POSES ---
const WOMAN_STAND_1 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHFFFEHH..",
  "...FFFFF....",
  "....FFFF....",
  "...LLCCLL...",
  "..LCCCCCLD..",
  "..LCCCCCLD..",
  ".LLCCCCCLDD.",
  ".LCCCCCCLDD.",
  "LLCCCCCCLLDD",
  "CCCCCCCCCCCC",
  "CCCCCCCCCCCC",
  "....FF.FF...",
  "....SS.SS...",
];

const WOMAN_WALK_1 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHFFFEHH..",
  "...FFFFF....",
  "....FFFF....",
  "...LLCCLL...",
  "..LCCCCCLD..",
  "..LCCCCCLD..",
  ".LLCCCCCLDD.",
  ".LCCCCCCLDD.",
  "LLCCCCCCLLDD",
  "CCCCCCCCCCCC",
  "CCCCCCCCCCCC",
  "...FF...FF..",
  "..SS.....SS.",
];

const WOMAN_WALK_2 = [
  "....HHHH....",
  "...HHHHHH...",
  "..HHFFFEHH..",
  "...FFFFF....",
  "....FFFF....",
  "...LLCCLL...",
  "..LCCCCCLD..",
  "..LCCCCCLD..",
  ".LLCCCCCLDD.",
  ".LCCCCCCLDD.",
  "LLCCCCCCLLDD",
  "CCCCCCCCCCCC",
  "CCCCCCCCCCCC",
  "....FFFF....",
  "....SSSS....",
];

const WOMAN_CLIMB_1 = [
  "..FFHHHH....",
  ".FFFHHHHHH..",
  ".FHHFFFEHH..",
  "...FFFFF....",
  "..LLCCLLFF..",
  "..LCCCCCLD..",
  ".LLCCCCCLDD.",
  "LLCCCCCCLLDD",
  "CCCCCCCCCCCC",
  "CCCCCCCCCCCC",
  "....FF.FF...",
  "...FF...FF..",
  "..SS.....SS.",
  "............",
  "............",
];

const WOMAN_CLIMB_2 = [
  "....HHHHFF..",
  "..HHHHHHFFF.",
  "..HHFFFEH.F.",
  "...FFFFF....",
  "..FFLLCCLL..",
  "..LCCCCCLD..",
  ".LLCCCCCLDD.",
  "LLCCCCCCLLDD",
  "CCCCCCCCCCCC",
  "CCCCCCCCCCCC",
  "....FF.FF...",
  "..FF.....FF.",
  ".SS.......SS",
  "............",
  "............",
];

const WOMAN_HANG_1 = [
  "..FF....FF..", // Hands stretched straight up grabbing the ledge
  "..FF....FF..",
  "..FF....FF..", // Bare arms
  "...LLCCLL...",
  "...HHHHHH...",
  "..HHFFFEHH..",
  "....FFFF....",
  "..LCCCCCLD..",
  ".LLCCCCCLDD.",
  "LLCCCCCCLLDD",
  "CCCCCCCCCCCC",
  "CCCCCCCCCCCC",
  "....FF.FF...",
  "...FF...FF..",
  "..SS.....SS.",
];

const WOMAN_HANG_2 = [
  "..FF....FF..",
  "..FF....FF..",
  "..FF....FF..",
  "...LLCCLL...",
  "...HHHHHH...",
  "..HHFFFEHH..",
  "....FFFF....",
  "..LCCCCCLD..",
  ".LLCCCCCLDD.",
  "LLCCCCCCLLDD",
  "CCCCCCCCCCCC",
  "CCCCCCCCCCCC",
  "....FFFF....",
  ".....FF.FF..",
  "......SSSS..",
];

const WOMAN_JUMP = [
  "..FF....FF..",
  "...HHHHHH...",
  "..HHFFFEHH..",
  "....FFFF....",
  "..LLCCLLDD..",
  ".LCCCCCLDDD.",
  "LLCCCCCCLLDD",
  "CCCCCCCCCCCC",
  "CCCCCCCCCCCC",
  "....FFFF....",
  "...FF...FF..",
  "..SS.....SS.",
  "............",
  "............",
  "............",
];

// --- COUPLE EMBRACE & CUDDLE ---
const COUPLE_EMBRACE = [
  "..HHHH..HHHH..",
  ".HHHHHHHHHHHH.",
  ".HFFEHH..HFEH.",
  "..FFFF.B.FFFF.",
  "..PPPPBBCCCC..",
  ".PPWWPBBCCCCD.",
  ".PPTTPBBCCCCD.",
  ".PPPPPBBCCCCD.",
  "..PPPP..CCCC..",
  "..PPPP..CCCC..",
  "..PP.PP.CC.CC.",
  "..PP.PP.CC.CC.",
  "..SS.SS.SS.SS.",
];

// Lying down horizontally cuddling on the platform
const COUPLE_CUDDLE = [
  "........................",
  "....HHHHH......HHHH.....",
  "..HHHHHHHHH..HHHHHHHH...",
  ".HHFFFEHHHH.HHFFFEEHHH..",
  ".HFFFFFBBHH.HFFFFFBBHH..",
  "..PPWWPPBBBB..CCCCCC....",
  ".PPPPPPTPBBBB.CCCCCCC...",
  ".PPPPPPPPBBBBCCCCCCCCD..",
  "..PPPPPPPP...CCCCCCCCD..",
  "....SSSS.......SSSS.....",
];

// Floating heart sprite (7x6)
export const PIXEL_HEART = [
  ".RR.RR.",
  "RHHIRHR",
  "RRRRRRR",
  ".RRRRR.",
  "..RRR..",
  "...R...",
];

export function getSpriteMatrix(
  kind: CharacterKind,
  state: AnimationState,
  frame: number,
): string[] {
  if (kind === "guy") {
    switch (state) {
      case "appear":
      case "walk_top":
        return frame % 2 === 0 ? GUY_WALK_1 : GUY_WALK_2;
      case "climb_up":
      case "climb_down":
        return frame % 2 === 0 ? GUY_CLIMB_1 : GUY_CLIMB_2;
      case "hang_traverse":
        return frame % 2 === 0 ? GUY_HANG_1 : GUY_HANG_2;
      case "jump":
        return GUY_JUMP;
      case "embrace":
        return GUY_STAND_1;
      case "cuddle":
        return GUY_STAND_1;
      case "scamper":
        return frame % 2 === 0 ? GUY_WALK_1 : GUY_WALK_2;
      default:
        return GUY_STAND_1;
    }
  } else {
    switch (state) {
      case "appear":
      case "walk_top":
        return frame % 2 === 0 ? WOMAN_WALK_1 : WOMAN_WALK_2;
      case "climb_up":
      case "climb_down":
        return frame % 2 === 0 ? WOMAN_CLIMB_1 : WOMAN_CLIMB_2;
      case "hang_traverse":
        return frame % 2 === 0 ? WOMAN_HANG_1 : WOMAN_HANG_2;
      case "jump":
        return WOMAN_JUMP;
      case "embrace":
        return WOMAN_STAND_1;
      case "cuddle":
        return WOMAN_STAND_1;
      case "scamper":
        return frame % 2 === 0 ? WOMAN_WALK_1 : WOMAN_WALK_2;
      default:
        return WOMAN_STAND_1;
    }
  }
}

/** Draw a pixel matrix sprite onto a canvas 2D context at integer scale */
export function drawPixelMatrix(
  ctx: CanvasRenderingContext2D,
  matrix: readonly string[],
  palette: Record<string, string>,
  x: number,
  y: number,
  scale = PIXEL_SCALE,
  flipHorizontal = false,
  alpha = 1.0,
): void {
  if (alpha <= 0) return;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * alpha;

  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;

  ctx.save();
  if (flipHorizontal) {
    ctx.translate(x + cols * scale, y);
    ctx.scale(-1, 1);
  } else {
    ctx.translate(x, y);
  }

  for (let r = 0; r < rows; r++) {
    const row = matrix[r] ?? "";
    for (let c = 0; c < cols; c++) {
      const char = row[c] ?? ".";
      if (char === ".") continue;
      const color = palette[char];
      if (color && color !== "transparent") {
        ctx.fillStyle = color;
        ctx.fillRect(c * scale, r * scale, scale, scale);
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = prevAlpha;
}

/** Draw the pair cuddling together on the platform */
export function drawCoupleCuddle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale = PIXEL_SCALE,
  alpha = 1.0,
): void {
  const compositePalette: Record<string, string> = {
    ...GUY_PALETTE,
    ...WOMAN_PALETTE,
    // Disambiguate overlap
    P: GUY_PALETTE["P"] ?? "#ec4899",
    W: GUY_PALETTE["W"] ?? "#ffffff",
    T: GUY_PALETTE["T"] ?? "#0f172a",
    C: WOMAN_PALETTE["C"] ?? "#0284c7",
    B: "#f43f5e",
  };
  drawPixelMatrix(ctx, COUPLE_CUDDLE, compositePalette, x, y, scale, false, alpha);
}

/** Draw the pair in mutual embrace */
export function drawCoupleEmbrace(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale = PIXEL_SCALE,
  alpha = 1.0,
): void {
  const compositePalette: Record<string, string> = {
    ...GUY_PALETTE,
    ...WOMAN_PALETTE,
    P: GUY_PALETTE["P"] ?? "#ec4899",
    C: WOMAN_PALETTE["C"] ?? "#0284c7",
    B: "#f43f5e",
  };
  drawPixelMatrix(ctx, COUPLE_EMBRACE, compositePalette, x, y, scale, false, alpha);
}

/** Draw the retro pixel-art platform as it scrolls out */
export function drawPixelPlatform(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  scale = PIXEL_SCALE,
  alpha = 1.0,
): void {
  if (width <= 0 || alpha <= 0) return;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * alpha;

  ctx.save();
  // Draw main plank
  ctx.fillStyle = PLATFORM_PALETTE["W"] ?? "#d97706";
  ctx.fillRect(x, y, width, height);

  // Top highlight line
  ctx.fillStyle = "#fde68a";
  ctx.fillRect(x, y, width, scale);

  // Bottom wood shadow
  ctx.fillStyle = PLATFORM_PALETTE["D"] ?? "#78350f";
  ctx.fillRect(x, y + height - scale, width, scale);

  // Wood plank lines every 16px
  ctx.fillStyle = PLATFORM_PALETTE["M"] ?? "#b45309";
  for (let px = x + 16 * scale; px < x + width; px += 16 * scale) {
    ctx.fillRect(px, y, scale, height);
  }

  // Supporting wall brackets
  const bracketSize = Math.min(height * 1.5, 18 * scale);
  ctx.fillStyle = PLATFORM_PALETTE["K"] ?? "#334155";
  ctx.fillRect(x, y + height, scale * 3, bracketSize);
  ctx.fillStyle = PLATFORM_PALETTE["I"] ?? "#64748b";
  ctx.fillRect(x + scale, y + height, scale, bracketSize);

  // Diagonal strut
  for (let i = 0; i < bracketSize; i += scale) {
    ctx.fillStyle = PLATFORM_PALETTE["K"] ?? "#334155";
    ctx.fillRect(x + i, y + height + bracketSize - i, scale, scale);
  }

  ctx.restore();
  ctx.globalAlpha = prevAlpha;
}
