# Adventure Time spins rest fairly

## Symptom
The operator: "you end up pretty much at the same point every spin". Live data: all 5 finished
rounds landed at sea, and 3 of 5 stopped within 20 degrees of a pole.

## Root cause
1. **Latitude was pole-heavy.** Spin 2 (axis `lat`) turns `phi`, unbounded, so the globe tumbles over
   the poles. The landing is the globe's centre and its latitude satisfies `sin(lat) = -sin(phi)` for
   every lambda (checked against d3 `geoRotation([lambda, phi]).invert([0, 0])`). A resting `phi`
   uniform mod 360 makes latitude uniform in degrees: about a third of spins stopped within 30
   degrees of a pole, where only 13.4 % of the Earth's area is.
2. **Whole-turn caps.** `planSpin` clamped the distance to 720..3600: exact whole turns, so every very
   gentle or very hard flick stopped exactly where it began.
3. **Nothing random.** The stopping place was a pure function of the start angle and the flick.

## Decision
The flick still decides the minimum distance (`base = clamp(1.5 x speed, 720, 3600)`) and the
duration. A random extra of always under one more turn is added so the resting angle mod 360 is drawn
from the fair distribution, independent of the start and the flick:

    extra = mod(sign * (restingAngle(axis, u) - (from + sign * base)), 360)
    delta = sign * (base + extra);  durationMs = clamp(3 * |delta| / speed * 1000, 3500, 7000)

`u` is the scene's `random()`. `restingAngle("lng", u) = 360 u`. For `lat`, `sin(lat) = -sin(phi)`
must be uniform on [-1, 1], which means `phi` has density `|cos phi| / 4` per radian over [-90, 270).
Inverse CDF: `u < 0.5 -> phi = asin(4u - 1)` (-90..90, not tumbled); `u >= 0.5 ->
phi = 180 - asin(3 - 4u)` (90..270, tumbled; same latitude law, longitude flipped by 180, which stays
uniform because lambda's own rest is uniform). The server's bound moves from 3600 to 3960
(`SPIN_MAX_DELTA_DEG`).

## Why
Fair by area (the share within 30 degrees of a pole is the true 13.4 %), no whole-turn repeats, and
the flick keeps its feel (distance and duration still follow it). Landing at sea and the glide to the
nearest land are deliberately kept: the operator called the glide "part of the fun, the surprise".

## What to watch
- The server bound must move with `MAX_SPIN_DELTA_DEG` (physics.ts) = flick cap + 360.
- Never pick the resting angle from `from` or the flick: it must depend only on `u`.
- A mismatched clamp (flick cap vs. server bound) could reintroduce whole-turn repeats or 422s.
