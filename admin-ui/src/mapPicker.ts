// The Contact panel's map picker (decisions/00129) — a small, self-contained,
// dependency-free slippy map: OSM raster tiles, drag-to-pan, +/- zoom, and an
// "armed" click-to-pin mode. Hand-rolled in the house style (no CDN, no
// framework — mirrors `alignerDialog.ts`'s split of DOM wiring here against
// pure geometry in `mapPickerModel.ts`).
//
// Rendering strategy: pan is a `transform: translate()` on the tile layer
// during the drag (cheap, smooth, no image churn) — the actual tile SET is
// only recomputed (`renderTiles`) on drag release / zoom / initial mount, so
// a fast drag never thrashes the network for tiles it's about to leave.

import {
  clampZoom,
  formatCoords,
  lonLatToWorldPixel,
  MAX_ZOOM,
  MIN_ZOOM,
  osmTileUrl,
  parseCoords,
  TILE_SIZE,
  tilesForViewport,
  worldPixelToLonLat,
} from "./mapPickerModel";

/** No pin yet: a UK-wide view lets her find her own area rather than opening
 * on an arbitrary point. */
const DEFAULT_CENTER = { lat: 54.5, lon: -3.5 };
const DEFAULT_ZOOM = 5;
/** A pin already exists: open close enough to see the street it's on. */
const PINNED_ZOOM = 16;

const VIEWPORT_HEIGHT_PX = 280;
/** Below this drag distance a pointer-up is a CLICK (pin placement when
 * armed), not a pan — distinguishes "tap to place" from "drag past here". */
const CLICK_VS_DRAG_THRESHOLD_PX = 4;

export interface MapPickerDeps {
  win: Window;
  /** `""` (no pin — address-derived map) or the stored `"lat,lng"`. */
  initialCoords: string;
  /** Fired with a freshly-formatted `"lat,lng"` from either a placed pin or a
   * validated manual text-input commit. */
  onPin: (coords: string) => void;
  onClear: () => void;
}

export interface MapPicker {
  element: HTMLElement;
  teardown(): void;
}

export function mountMapPicker(deps: MapPickerDeps): MapPicker {
  const win = deps.win;
  // The global `document`, not `win.document` — matches `contactPanel.ts`'s
  // (and `settingsPanel.ts`'s) own convention of building DOM off the real
  // document directly; `win` here is only for the injectable/testable
  // browser-API surface (events, RAF), same split `shortcuts.ts` uses.
  const doc = document;

  const initialParsed = parseCoords(deps.initialCoords);
  let pin: { lat: number; lng: number } | null = initialParsed;
  let centerLat = initialParsed?.lat ?? DEFAULT_CENTER.lat;
  let centerLon = initialParsed?.lng ?? DEFAULT_CENTER.lon;
  let zoom = initialParsed !== null ? PINNED_ZOOM : DEFAULT_ZOOM;
  let armed = false;

  const root = doc.createElement("div");
  root.className = "wx-map-picker";

  const viewport = doc.createElement("div");
  viewport.className = "wx-map-viewport";
  viewport.style.height = `${VIEWPORT_HEIGHT_PX}px`;

  const tileLayer = doc.createElement("div");
  tileLayer.className = "wx-map-tiles";

  const marker = doc.createElement("div");
  marker.className = "wx-map-marker";
  marker.hidden = true;

  const attribution = doc.createElement("a");
  attribution.className = "wx-map-attribution";
  attribution.href = "https://www.openstreetmap.org/copyright";
  attribution.target = "_blank";
  attribution.rel = "noopener";
  attribution.textContent = "© OpenStreetMap contributors";

  const zoomControls = doc.createElement("div");
  zoomControls.className = "wx-map-zoom-controls";
  const zoomInButton = doc.createElement("button");
  zoomInButton.type = "button";
  zoomInButton.className = "wx-map-zoom-button";
  zoomInButton.textContent = "+";
  zoomInButton.setAttribute("aria-label", "Zoom in");
  const zoomOutButton = doc.createElement("button");
  zoomOutButton.type = "button";
  zoomOutButton.className = "wx-map-zoom-button";
  zoomOutButton.textContent = "−";
  zoomOutButton.setAttribute("aria-label", "Zoom out");
  zoomControls.append(zoomOutButton, zoomInButton);

  viewport.append(tileLayer, marker, attribution, zoomControls);
  root.appendChild(viewport);

  function updateZoomButtons(): void {
    zoomInButton.disabled = zoom >= MAX_ZOOM;
    zoomOutButton.disabled = zoom <= MIN_ZOOM;
  }

  function centerWorldPixel(): { x: number; y: number } {
    return lonLatToWorldPixel(centerLon, centerLat, zoom);
  }

  // One shared fallback (jsdom / a hidden or mid-transition panel reports 0)
  // used EVERYWHERE the viewport's width feeds pixel math — tiles, marker
  // placement, and click-to-pin all disagreeing on this would misplace the
  // marker/pin relative to what was actually clicked.
  function viewportWidth(): number {
    return viewport.clientWidth || 320;
  }

  function renderMarker(): void {
    if (pin === null) {
      marker.hidden = true;
      return;
    }
    marker.hidden = false;
    const center = centerWorldPixel();
    const pinWorld = lonLatToWorldPixel(pin.lng, pin.lat, zoom);
    const screenX = pinWorld.x - center.x + viewportWidth() / 2;
    const screenY = pinWorld.y - center.y + VIEWPORT_HEIGHT_PX / 2;
    marker.style.left = `${screenX}px`;
    marker.style.top = `${screenY}px`;
  }

  function renderTiles(): void {
    tileLayer.style.transform = "";
    tileLayer.innerHTML = "";
    const center = centerWorldPixel();
    const tiles = tilesForViewport(center.x, center.y, viewportWidth(), VIEWPORT_HEIGHT_PX, zoom);
    for (const tile of tiles) {
      const img = doc.createElement("img");
      img.className = "wx-map-tile";
      img.alt = "";
      img.draggable = false;
      img.style.left = `${tile.screenX}px`;
      img.style.top = `${tile.screenY}px`;
      img.width = TILE_SIZE;
      img.height = TILE_SIZE;
      img.src = osmTileUrl(tile.tileX, tile.tileY, zoom);
      tileLayer.appendChild(img);
    }
    renderMarker();
    updateZoomButtons();
    clearButton.disabled = pin === null;
  }

  function setZoom(next: number): void {
    zoom = clampZoom(next);
    renderTiles();
  }

  // -- Drag-to-pan + armed click-to-pin ----------------------------------------

  let dragPointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragTotalDeltaX = 0;
  let dragTotalDeltaY = 0;

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragTotalDeltaX = 0;
    dragTotalDeltaY = 0;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("wx-map-dragging");
  });

  viewport.addEventListener("pointermove", (event) => {
    if (dragPointerId !== event.pointerId) return;
    dragTotalDeltaX = event.clientX - dragStartX;
    dragTotalDeltaY = event.clientY - dragStartY;
    tileLayer.style.transform = `translate(${dragTotalDeltaX}px, ${dragTotalDeltaY}px)`;
    marker.style.transform = `translate(${dragTotalDeltaX}px, ${dragTotalDeltaY}px)`;
  });

  function endDrag(event: PointerEvent): void {
    if (dragPointerId !== event.pointerId) return;
    viewport.releasePointerCapture(event.pointerId);
    viewport.classList.remove("wx-map-dragging");
    dragPointerId = null;
    marker.style.transform = "";

    const dragDistance = Math.hypot(dragTotalDeltaX, dragTotalDeltaY);
    if (dragDistance < CLICK_VS_DRAG_THRESHOLD_PX) {
      if (armed) {
        const rect = viewport.getBoundingClientRect();
        const clickX = event.clientX - rect.left;
        const clickY = event.clientY - rect.top;
        const center = centerWorldPixel();
        const worldX = center.x - viewportWidth() / 2 + clickX;
        const worldY = center.y - VIEWPORT_HEIGHT_PX / 2 + clickY;
        const { lon, lat } = worldPixelToLonLat(worldX, worldY, zoom);
        pin = { lat, lng: lon };
        setArmed(false);
        renderTiles();
        deps.onPin(formatCoords(lat, lon));
      }
      return;
    }

    // A real drag: fold the pixel delta into the center lat/lon and re-tile.
    const center = centerWorldPixel();
    const newCenterWorld = { x: center.x - dragTotalDeltaX, y: center.y - dragTotalDeltaY };
    const { lon, lat } = worldPixelToLonLat(newCenterWorld.x, newCenterWorld.y, zoom);
    centerLat = lat;
    centerLon = lon;
    renderTiles();
  }
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  zoomInButton.addEventListener("click", () => setZoom(zoom + 1));
  zoomOutButton.addEventListener("click", () => setZoom(zoom - 1));

  // -- Armed toggle + manual text entry + clear --------------------------------

  const controls = doc.createElement("div");
  controls.className = "wx-map-controls";

  const armButton = doc.createElement("button");
  armButton.type = "button";
  armButton.className = "wx-settings-link-button wx-map-arm-button";

  function setArmed(next: boolean): void {
    armed = next;
    armButton.textContent = armed ? "Click the map to place your pin…" : "Click to pin coordinates";
    armButton.classList.toggle("wx-map-arm-button-active", armed);
    viewport.classList.toggle("wx-map-armed", armed);
  }
  setArmed(false);
  armButton.addEventListener("click", () => setArmed(!armed));

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && armed) setArmed(false);
  }
  win.addEventListener("keydown", onKeydown);

  const coordsRow = doc.createElement("div");
  coordsRow.className = "wx-map-coords-row";
  const coordsInput = doc.createElement("input");
  coordsInput.type = "text";
  coordsInput.className = "wx-settings-input wx-map-coords-input";
  coordsInput.placeholder = "lat, lng — e.g. 52.379464, -2.222315";
  coordsInput.value = initialParsed !== null ? formatCoords(initialParsed.lat, initialParsed.lng) : "";
  const coordsHint = doc.createElement("p");
  coordsHint.className = "wx-settings-hint wx-map-coords-hint";
  coordsHint.textContent = "Or type coordinates directly, e.g. from a phone GPS reading.";

  coordsInput.addEventListener("change", () => {
    const raw = coordsInput.value.trim();
    if (raw === "") return; // blank commits nothing — use Clear pin instead
    const parsed = parseCoords(raw);
    if (parsed === null) {
      coordsHint.textContent = "That doesn't look like \"lat, lng\" — e.g. 52.379464, -2.222315.";
      coordsHint.classList.add("wx-map-coords-hint-error");
      return;
    }
    coordsHint.textContent = "Or type coordinates directly, e.g. from a phone GPS reading.";
    coordsHint.classList.remove("wx-map-coords-hint-error");
    pin = { lat: parsed.lat, lng: parsed.lng };
    centerLat = parsed.lat;
    centerLon = parsed.lng;
    zoom = PINNED_ZOOM;
    coordsInput.value = formatCoords(parsed.lat, parsed.lng);
    renderTiles();
    deps.onPin(formatCoords(parsed.lat, parsed.lng));
  });

  const clearButton = doc.createElement("button");
  clearButton.type = "button";
  clearButton.className = "wx-settings-link-button wx-map-clear-button";
  clearButton.textContent = "Clear pin";
  clearButton.disabled = pin === null;
  clearButton.addEventListener("click", () => {
    pin = null;
    coordsInput.value = "";
    zoom = DEFAULT_ZOOM;
    clearButton.disabled = true;
    renderTiles();
    deps.onClear();
  });

  coordsRow.append(coordsInput, clearButton);
  controls.append(armButton, coordsRow, coordsHint);
  root.appendChild(controls);

  // Initial tile paint waits one frame so `viewport.clientWidth` reflects real
  // layout (0 in the same synchronous tick a hidden/unmounted ancestor would
  // report it) — mirrors `viewportScaleFor`'s own pre-layout-fallback caveat.
  win.requestAnimationFrame(() => renderTiles());

  return {
    element: root,
    teardown(): void {
      win.removeEventListener("keydown", onKeydown);
    },
  };
}
