# 00019 [5x1phx] Adventure Time: fair, unpredictable spin landings

Operator, 2026-10-29: "you end up pretty much at the same point every spin". Approved fix (Answers
entry "Why Adventure Time keeps landing in the same places, and how to make it random"):
1. a random extra on BOTH spins, always under one extra full turn, so the flick still decides how far
   and how long the globe spins (a gentle nudge stays gentle);
2. the up-and-down spin rests at a latitude in proportion to the Earth's real area (near-pole landings
   from about 1 in 3 to about 1 in 7);
3. no exact repeats: a capped flick (720 / 3600 degrees, whole turns) must no longer stop exactly where
   it started.
Keep: the sea landing and its glide to the nearest land ("part of the fun, the surprise").

Measured before the fix (live `adv_rounds`, 5 finished rounds): all 5 at sea (South Georgia x2,
Greenland, Pitcairn, Azores); 3 of 5 within 20 degrees of a pole.

Design (driver): sample the spin's resting angle (mod 360) directly from the fair distribution, then
travel the flick's own distance plus whatever extra (in [0, 360)) reaches it. Longitude: uniform.
Latitude: `sin(lat) = -sin(phi)` for every lambda (checked against d3 geoRotation, max error 2e-15),
so area-fair means phi mod 360 has density |cos phi| / 4. Server bound `|delta|` becomes 720..3960.

Work: Sonnet builder (cmd delegate) on branch adv/spin-fair-landing; driver reviews and ships.
