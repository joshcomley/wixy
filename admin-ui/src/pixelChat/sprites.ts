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

// ==========================================
// GUY SPRITES (12 wide x 15 high, Crawl: 16x15)
// ==========================================

export const GUY_STAND_1 = [
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

// --- 4-Frame Walk Cycle (Contact -> Passing Rise -> Contact Opp -> Passing Rise) ---
export const GUY_WALK_1 = [
  "...HHHHH....",
  "..HHHHHHH...",
  ".HFEFFHHH...",
  ".FFFFFFPP...",
  "..LLPPWWP...",
  ".FLLPPPTPPD.",
  "..LPPPPPDD..",
  "...PPPPPDD..",
  "...PP..PP...",
  "..PP....PP..",
  "..PP....PP..",
  ".PP......PP.",
  ".PP......PP.",
  "SS........SS",
  "............",
];

export const GUY_WALK_2 = [
  "...HHHHH....",
  "..HHHHHHH...",
  ".HFEFFHHH...",
  ".FFFFFFPP...",
  "..LLPPWWPD..",
  "..LPPPTPPD..",
  "..DPPPPPDD..",
  "...PPPPPD...",
  "....PPPP....",
  "....PPPP....",
  "....PP.PP...",
  "....PP..PP..",
  "....SS...SS.",
  "....SS......",
  "............",
];

export const GUY_WALK_3 = [
  "...HHHHH....",
  "..HHHHHHH...",
  ".HFEFFHHH...",
  ".FFFFFFPP...",
  "..LLPPWWP...",
  "..LPPPTPPLLF",
  "..LPPPPPDD..",
  ".F.PPPPPDD..",
  "...PP..PP...",
  "..PP....PP..",
  "..PP....PP..",
  ".PP......PP.",
  ".PP......PP.",
  "SS........SS",
  "............",
];

export const GUY_WALK_4 = [
  "...HHHHH....",
  "..HHHHHHH...",
  ".HFEFFHHH...",
  ".FFFFFFPP...",
  "..LLPPWWPD..",
  "..LPPPTPPD..",
  "..DPPPPPDD..",
  "...PPPPPD...",
  "....PPPP....",
  "....PPPP....",
  "...PP.PP....",
  "..PP..PP....",
  ".SS...SS....",
  "......SS....",
  "............",
];

// --- 4-Frame Climbing Cycle (Side-profile wall-scaling: hand-over-hand, wall foot-plant, pull-up surge) ---
export const GUY_CLIMB_1 = [
  "FF..........",
  "FF..HHHH....",
  "..FHHHHHH...",
  ".FEFFHHHH...",
  ".FFFFPPPP...",
  ".LLPPWWPP...",
  "FFPPPTPPD...",
  "..PPPPPDD...",
  "SSPPPPPD....",
  "SSPP..PP....",
  "....PPPP....",
  "....PP......",
  "....PP......",
  "....SS......",
  "............",
];

export const GUY_CLIMB_2 = [
  "....HHHH....",
  "...HHHHHH...",
  "..FEFFHHH...",
  "FFFFFFPPPP..",
  ".LLPPWWPPD..",
  "FFPPPTPPDD..",
  "..PPPPPDD...",
  "..PPPPPD....",
  "SSPPPP......",
  "SS..PP......",
  "...PPP......",
  "...SS.......",
  "............",
  "............",
  "............",
];

export const GUY_CLIMB_3 = [
  "FF..........",
  "FFF.HHHH....",
  "..FHHHHHH...",
  "..FEFFHHH...",
  "..FFFFLLPP..",
  "..LLPPWWPD..",
  "FFPPPTPPDD..",
  "..PPPPPDD...",
  "..PPPPPD....",
  "SSPPPP......",
  "SS..PP......",
  "....PP......",
  "....PP......",
  "....SS......",
  "............",
];

export const GUY_CLIMB_4 = [
  "...HHHH.....",
  "..HHHHHH....",
  ".FEFFHHH....",
  "FFFFFFPPPP..",
  ".LLPPWWPPD..",
  ".FPPPTPPDD..",
  "..PPPPPDD...",
  "SSPPPPPD....",
  "SS..PPPP....",
  "....PP......",
  "....PP......",
  "....SS......",
  "............",
  "............",
  "............",
];

// --- 4-Frame Monkey-bar Traversal (Arms gripping ceiling ledge, pendulum swinging legs) ---
export const GUY_HANG_1 = [
  "..FF....FF..",
  "..FF....FF..",
  "..LL....LL..",
  "...LLPPLL...",
  "...HHHHHH...",
  "..HFEFFHHH..",
  "..FFFFFFPP..",
  "..LLPPWWPD..",
  "..LPPPTPPD..",
  "..DPPPPPDD..",
  "...PPPPPD...",
  "....PP..PP..",
  ".....PP..PP.",
  "......PP..PP",
  "......SS..SS",
];

export const GUY_HANG_2 = [
  "..FF....FF..",
  "..FF....FF..",
  "..LL....LL..",
  "...LLPPLL...",
  "...HHHHHH...",
  "..HFEFFHHH..",
  "..FFFFFFPP..",
  "..LLPPWWPD..",
  "..LPPPTPPD..",
  "..DPPPPPDD..",
  "...PPPPPD...",
  "....PPPP....",
  "....PP.PP...",
  "....PP.PP...",
  "....SS.SS...",
];

export const GUY_HANG_3 = [
  "..FF....FF..",
  "..FF....FF..",
  "..LL....LL..",
  "...LLPPLL...",
  "...HHHHHH...",
  "..HFEFFHHH..",
  "..FFFFFFPP..",
  "..LLPPWWPD..",
  "..LPPPTPPD..",
  "..DPPPPPDD..",
  "...PPPPPD...",
  "..PP..PP....",
  ".PP..PP.....",
  "PP..PP......",
  "SS..SS......",
];

export const GUY_HANG_4 = [
  "..FF....FF..",
  "..FF....FF..",
  "..LL....LL..",
  "...LLPPLL...",
  "...HHHHHH...",
  "..HFEFFHHH..",
  "..FFFFFFPP..",
  "..LLPPWWPD..",
  "..LPPPTPPD..",
  "..DPPPPPDD..",
  "...PPPPPD...",
  "....PPPP....",
  "...PP..PP...",
  "...PP..PP...",
  "...SS..SS...",
];

// --- 4-Frame Crawling Cycle (Horizontal quadrupedal hands-and-knees weight transfer under overhangs) ---
export const GUY_CRAWL_1 = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....HHHHHH......",
  "...HFEFFHHHH....",
  "...FFFFFLLPP....",
  "FF.LLPPWWPPPDD..",
  "FF.FPPPTPPPPPPD.",
  "...LLPP.PP...PPD",
  "..SS....SS..SSSS",
  "................",
  "................",
];

export const GUY_CRAWL_2 = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....HHHHHH......",
  "...HFEFFHHHH....",
  "...FFFFFLLPP....",
  "..LLPPWWPPPDD...",
  ".FFPPPTPPPPPPD..",
  ".FFLLPP.PP..PPPD",
  "...SS...PP..SSSS",
  "................",
  "................",
];

export const GUY_CRAWL_3 = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....HHHHHH......",
  "...HFEFFHHHH....",
  "...FFFFFLLPP....",
  "FF.LLPPWWPPPDD..",
  "FF.LLPPTPPPPPPD.",
  "...FPPP.PPPP..PD",
  "..SS......SSSSSS",
  "................",
  "................",
];

export const GUY_CRAWL_4 = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....HHHHHH......",
  "...HFEFFHHHH....",
  "...FFFFFLLPP....",
  "..LLPPWWPPPDD...",
  ".FFLLPPTPPPPPD..",
  ".FF.PPP.PPPPPPPD",
  "...SS...SSSS....",
  "................",
  "................",
];

export const GUY_JUMP = [
  "FF..........",
  ".FF.HHHH....",
  "..FHHHHHH...",
  "..FEFFHHH...",
  "..FFFFLLPP..",
  "..LLPPWWPD..",
  "..LPPPTPPDD.",
  "...DPPPPPD..",
  "....PPPP....",
  "...PP..PP...",
  "..PP....PP..",
  "..PP....PP..",
  ".SS......SS.",
  "............",
  "............",
];

export const GUY_STUMBLE_1 = [
  "..FF....FF..",
  ".FFF....FFF.",
  "...HHHHHH...",
  "..HHEFFEEH..",
  "...FFFFF....",
  "..LLPPWWLL..",
  ".LLPPPPPPLL.",
  "LL..PPPP..LL",
  "....PPPP....",
  "....DPPD....",
  "...PP..PP...",
  "..PP....PP..",
  "..SS.....SS.",
  "............",
  "............",
];

export const GUY_STUMBLE_2 = [
  "FF........FF",
  ".FFF....FFF.",
  "...HHHHHH...",
  "..HHEFFEEH..",
  "...FFFFFF...",
  "...LPPWWPL..",
  "..LLPPPPLL..",
  "..L.PPPP.L..",
  "....PPPP....",
  "....DPPD....",
  "....PPPP....",
  "...PP..PP...",
  "...SS..SS...",
  "............",
  "............",
];

// ==========================================
// WOMAN SPRITES (12 wide x 15 high, Crawl: 16x15)
// ==========================================

export const WOMAN_STAND_1 = [
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

// --- 4-Frame Walk Cycle (Dress swaying, foot passing, head bob) ---
export const WOMAN_WALK_1 = [
  "...HHHHH....",
  "..HHHHHHH...",
  ".HFEFFHHH...",
  ".FFFFFFCC...",
  "..LLCCWWCD..",
  ".FLLCCCCCDD.",
  "..LCCCCCDD..",
  ".DDCCCCCCDD.",
  "DDCCCCCCCCDD",
  ".CCCCCCCCCC.",
  "..FF....FF..",
  "..FF....FF..",
  "..FF....FF..",
  ".SS......SS.",
  "............",
];

export const WOMAN_WALK_2 = [
  "...HHHHH....",
  "..HHHHHHH...",
  ".HFEFFHHH...",
  ".FFFFFFCC...",
  "..LLCCWWCD..",
  "..LCCCCCDD..",
  "..DCCCCCDD..",
  "...CCCCCD...",
  "...CCCCCC...",
  "...CCCCCC...",
  "....FF.FF...",
  "....FF..FF..",
  "....SS...SS.",
  "....SS......",
  "............",
];

export const WOMAN_WALK_3 = [
  "...HHHHH....",
  "..HHHHHHH...",
  ".HFEFFHHH...",
  ".FFFFFFCC...",
  "..LLCCWWCD..",
  "..LCCCCCCLLF",
  "..LCCCCCDD..",
  ".DDCCCCCCDD.",
  "DDCCCCCCCCDD",
  ".CCCCCCCCCC.",
  "..FF....FF..",
  "..FF....FF..",
  "..FF....FF..",
  ".SS......SS.",
  "............",
];

export const WOMAN_WALK_4 = [
  "...HHHHH....",
  "..HHHHHHH...",
  ".HFEFFHHH...",
  ".FFFFFFCC...",
  "..LLCCWWCD..",
  "..LCCCCCDD..",
  "..DCCCCCDD..",
  "...CCCCCD...",
  "...CCCCCC...",
  "...CCCCCC...",
  "...FF.FF....",
  "..FF..FF....",
  ".SS...SS....",
  "......SS....",
  "............",
];

// --- 4-Frame Climbing Cycle (Side-profile wall-scaling: hand-over-hand, wall foot-plant, dress gathering) ---
export const WOMAN_CLIMB_1 = [
  "FF..........",
  "FF..HHHH....",
  "..FHHHHHH...",
  ".FEFFHHHH...",
  ".FFFFCCCC...",
  ".LLCCWWCC...",
  "FFCCCWCCDD..",
  "..CCCCCCDD..",
  "SSCCCCCCD...",
  "SSCCCCDD....",
  "..CCCCCC....",
  "....FF......",
  "....FF......",
  "....SS......",
  "............",
];

export const WOMAN_CLIMB_2 = [
  "....HHHH....",
  "...HHHHHH...",
  "..FEFFHHH...",
  "FFFFFFCCCC..",
  ".LLCCWWCCD..",
  "FFCCCCWCDD..",
  "..CCCCCCDD..",
  "..CCCCCCD...",
  "SSCCCCCC....",
  "SS..CCCC....",
  "...FF.FF....",
  "...SS.SS....",
  "............",
  "............",
  "............",
];

export const WOMAN_CLIMB_3 = [
  "FF..........",
  "FFF.HHHH....",
  "..FHHHHHH...",
  "..FEFFHHH...",
  "..FFFFLLCC..",
  "..LLCCWWCD..",
  "FFCCCWCCDD..",
  "..CCCCCCDD..",
  "..CCCCCCD...",
  "SSCCCCCC....",
  "SS..CCCC....",
  "....FF......",
  "....FF......",
  "....SS......",
  "............",
];

export const WOMAN_CLIMB_4 = [
  "...HHHH.....",
  "..HHHHHH....",
  ".FEFFHHH....",
  "FFFFFFCCCC..",
  ".LLCCWWCCD..",
  ".FCCCWCCDD..",
  "..CCCCCCDD..",
  "SSCCCCCCD...",
  "SS..CCCC....",
  "....FF......",
  "....FF......",
  "....SS......",
  "............",
  "............",
  "............",
];

// --- 4-Frame Monkey-bar Traversal (Arms gripping ceiling ledge, pendulum swinging legs) ---
export const WOMAN_HANG_1 = [
  "..FF....FF..",
  "..FF....FF..",
  "..LL....LL..",
  "...LLCCLL...",
  "...HHHHHH...",
  "..HFEFFHHH..",
  "..FFFFFFCC..",
  "..LLCCWWCD..",
  "..LCCCCCDD..",
  "..DCCCCCDD..",
  "...CCCCCD...",
  "....CC..CC..",
  ".....FF..FF.",
  "......FF..FF",
  "......SS..SS",
];

export const WOMAN_HANG_2 = [
  "..FF....FF..",
  "..FF....FF..",
  "..LL....LL..",
  "...LLCCLL...",
  "...HHHHHH...",
  "..HFEFFHHH..",
  "..FFFFFFCC..",
  "..LLCCWWCD..",
  "..LCCCCCDD..",
  "..DCCCCCDD..",
  "...CCCCCD...",
  "....CCCC....",
  "....FF.FF...",
  "....FF.FF...",
  "....SS.SS...",
];

export const WOMAN_HANG_3 = [
  "..FF....FF..",
  "..FF....FF..",
  "..LL....LL..",
  "...LLCCLL...",
  "...HHHHHH...",
  "..HFEFFHHH..",
  "..FFFFFFCC..",
  "..LLCCWWCD..",
  "..LCCCCCDD..",
  "..DCCCCCDD..",
  "...CCCCCD...",
  "..CC..CC....",
  ".FF..FF.....",
  "FF..FF......",
  "SS..SS......",
];

export const WOMAN_HANG_4 = [
  "..FF....FF..",
  "..FF....FF..",
  "..LL....LL..",
  "...LLCCLL...",
  "...HHHHHH...",
  "..HFEFFHHH..",
  "..FFFFFFCC..",
  "..LLCCWWCD..",
  "..LCCCCCDD..",
  "..DCCCCCDD..",
  "...CCCCCD...",
  "....CCCC....",
  "...FF..FF...",
  "...FF..FF...",
  "...SS..SS...",
];

// --- 4-Frame Crawling Cycle (Horizontal quadrupedal hands-and-knees weight transfer under overhangs) ---
export const WOMAN_CRAWL_1 = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....HHHHHHHH....",
  "...HFEFFHHHHH...",
  "...FFFFFLLCC....",
  "FF.LLCCWWCCCDD..",
  "FF.FCCCWCCCCCCD.",
  "...LLCC.CC...CCD",
  "..SS....FF..SSSS",
  "........SS......",
  "................",
];

export const WOMAN_CRAWL_2 = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....HHHHHHHH....",
  "...HFEFFHHHHH...",
  "...FFFFFLLCC....",
  "..LLCCWWCCCDD...",
  ".FFCCCWCCCCCCD..",
  ".FFLLCC.CC..CCCD",
  "...SS...FF..SSSS",
  "........SS......",
  "................",
];

export const WOMAN_CRAWL_3 = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....HHHHHHHH....",
  "...HFEFFHHHHH...",
  "...FFFFFLLCC....",
  "FF.LLCCWWCCCDD..",
  "FF.LLCCWCCCCCCD.",
  "...FCCC.CCCC..CD",
  "..SS......SSSSSS",
  "........SS......",
  "................",
];

export const WOMAN_CRAWL_4 = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....HHHHHHHH....",
  "...HFEFFHHHHH...",
  "...FFFFFLLCC....",
  "..LLCCWWCCCDD...",
  ".FFLLCCWCCCCCCD.",
  ".FF.CCC.CCCCCCCD",
  "...SS...SSSS....",
  "........SS......",
  "................",
];

export const WOMAN_JUMP = [
  "FF..........",
  ".FF.HHHH....",
  "..FHHHHHH...",
  "..FEFFHHH...",
  "..FFFFLLCC..",
  "..LLCCWWCD..",
  "..LCCCCCDD..",
  "...DCCCCCCD.",
  "....DDCCDD..",
  "...FF..FF...",
  "..FF....FF..",
  "..FF....FF..",
  ".SS......SS.",
  "............",
  "............",
];

export const WOMAN_STUMBLE_1 = [
  "..FF....FF..",
  ".FFF....FFF.",
  "...HHHHHH...",
  "..HHEFFEEH..",
  "...FFFFF....",
  "..LLCCLL....",
  ".LCCCCCLD...",
  "LLCCCCCLDD..",
  "CCCCCCCCCCCC",
  "CCCCCCCCCCCC",
  "...FF..FF...",
  "..FF....FF..",
  "..SS.....SS.",
  "............",
  "............",
];

export const WOMAN_STUMBLE_2 = [
  "FF........FF",
  ".FFF....FFF.",
  "...HHHHHH...",
  "..HHEFFEEH..",
  "...FFFFF....",
  "...LLCCLL...",
  "..LCCCCCLD..",
  ".LLCCCCCLDD.",
  "CCCCCCCCCCCC",
  "CCCCCCCCCCCC",
  "....FF.FF...",
  "...FF...FF..",
  "...SS...SS..",
  "............",
  "............",
];

// ==========================================
// COUPLE EMBRACE, CUDDLE & SLIDE FALL
// ==========================================

export const COUPLE_EMBRACE = [
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

export const COUPLE_CUDDLE = [
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

export const COUPLE_SLIDE_FALL = [
  "......HHHH...HHHH...",
  "....HHHHHHHHHHHHHHHH",
  "...HHEFFEH...HEFFEH.",
  "....FFFFF.BB.FFFFF..",
  "...LLPPWWBBBBCCLL...",
  "..LLPPPPPPBBCCCCLL..",
  ".LLPPPPPPPBBCCCCCLLD",
  ".DPPPPPPPPCCCCCCCCD.",
  "..DPPPPPP.CCCCCCCC..",
  "...PP..PP..CC..CC...",
  "..PP....PP..CC..CC..",
  "..SS....SS..SS..SS..",
  "....................",
  "....................",
];

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
  const f4 = Math.abs(Math.floor(frame)) % 4;
  const f2 = Math.abs(Math.floor(frame)) % 2;

  if (kind === "guy") {
    switch (state) {
      case "appear":
      case "walk_top":
      case "scamper":
        return [GUY_WALK_1, GUY_WALK_2, GUY_WALK_3, GUY_WALK_4][f4]!;
      case "climb_up":
      case "climb_down":
        return [GUY_CLIMB_1, GUY_CLIMB_2, GUY_CLIMB_3, GUY_CLIMB_4][f4]!;
      case "hang_traverse":
        return [GUY_HANG_1, GUY_HANG_2, GUY_HANG_3, GUY_HANG_4][f4]!;
      case "crawl":
        return [GUY_CRAWL_1, GUY_CRAWL_2, GUY_CRAWL_3, GUY_CRAWL_4][f4]!;
      case "jump":
        return GUY_JUMP;
      case "embrace":
      case "cuddle":
        return GUY_STAND_1;
      case "stumble":
      case "slide_fall":
        return [GUY_STUMBLE_1, GUY_STUMBLE_2][f2]!;
      default:
        return GUY_STAND_1;
    }
  } else {
    switch (state) {
      case "appear":
      case "walk_top":
      case "scamper":
        return [WOMAN_WALK_1, WOMAN_WALK_2, WOMAN_WALK_3, WOMAN_WALK_4][f4]!;
      case "climb_up":
      case "climb_down":
        return [WOMAN_CLIMB_1, WOMAN_CLIMB_2, WOMAN_CLIMB_3, WOMAN_CLIMB_4][f4]!;
      case "hang_traverse":
        return [WOMAN_HANG_1, WOMAN_HANG_2, WOMAN_HANG_3, WOMAN_HANG_4][f4]!;
      case "crawl":
        return [WOMAN_CRAWL_1, WOMAN_CRAWL_2, WOMAN_CRAWL_3, WOMAN_CRAWL_4][f4]!;
      case "jump":
        return WOMAN_JUMP;
      case "embrace":
      case "cuddle":
        return WOMAN_STAND_1;
      case "stumble":
      case "slide_fall":
        return [WOMAN_STUMBLE_1, WOMAN_STUMBLE_2][f2]!;
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
  const mergedPalette: Record<string, string> = {
    ...GUY_PALETTE,
    ...WOMAN_PALETTE,
    P: GUY_PALETTE.P!,
    C: WOMAN_PALETTE.C!,
  };
  drawPixelMatrix(ctx, COUPLE_CUDDLE, mergedPalette, x, y, scale, false, alpha);
}

/** Draw the couple embracing at the edge before leaping */
export function drawCoupleEmbrace(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale = PIXEL_SCALE,
  alpha = 1.0,
): void {
  const mergedPalette: Record<string, string> = {
    ...GUY_PALETTE,
    ...WOMAN_PALETTE,
  };
  drawPixelMatrix(ctx, COUPLE_EMBRACE, mergedPalette, x, y, scale, false, alpha);
}

/** Draw couple sliding together down collapsing platform */
export function drawCoupleSlideFall(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale = PIXEL_SCALE,
  alpha = 1.0,
): void {
  const mergedPalette: Record<string, string> = {
    ...GUY_PALETTE,
    ...WOMAN_PALETTE,
    P: GUY_PALETTE.P!,
    C: WOMAN_PALETTE.C!,
    B: "#f43f5e",
  };
  drawPixelMatrix(ctx, COUPLE_SLIDE_FALL, mergedPalette, x, y, scale, false, alpha);
}

/** Draw the retro wooden platform scrolling out from the wall */
export function drawPixelPlatform(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  scale = PIXEL_SCALE,
  alpha = 1.0,
): void {
  if (width <= 0) return;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * alpha;

  ctx.save();

  // Top wood edge (light highlight)
  ctx.fillStyle = PLATFORM_PALETTE.W!;
  ctx.fillRect(x, y, width, scale * 2);

  // Middle wood grain (medium tone)
  ctx.fillStyle = PLATFORM_PALETTE.M!;
  ctx.fillRect(x, y + scale * 2, width, height - scale * 4);

  // Bottom wood shadow
  ctx.fillStyle = PLATFORM_PALETTE.D!;
  ctx.fillRect(x, y + height - scale * 2, width, scale * 2);

  // Vertical wood plank separation lines every 24px
  ctx.fillStyle = PLATFORM_PALETTE.D!;
  for (let px = x + 24; px < x + width; px += 24) {
    ctx.fillRect(px, y, scale, height);
  }

  // Bracket at anchor point (wall end)
  ctx.fillStyle = PLATFORM_PALETTE.K!;
  ctx.fillRect(x + width - scale * 3, y, scale * 3, height);
  ctx.fillStyle = PLATFORM_PALETTE.I!;
  ctx.fillRect(x + width - scale * 2, y + scale * 2, scale, scale * 2);
  ctx.fillRect(x + width - scale * 2, y + height - scale * 4, scale, scale * 2);

  // Diagonal support strut underneath the wall hinge
  const bSize = Math.min(18, Math.floor(width * 0.4));
  ctx.fillStyle = PLATFORM_PALETTE.D!;
  for (let i = 0; i < bSize; i += scale) {
    ctx.fillRect(x + width - bSize + i, y + height + i, scale * 2, scale);
  }

  ctx.restore();
  ctx.globalAlpha = prevAlpha;
}
