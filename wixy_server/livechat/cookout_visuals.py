"""Cookout ingredient pictures and catalogue text, joined for the wire (spec 09b section B.7, E).

`IngredientVisuals` joins three engine-catalogue sources by ingredient id, at read time:

- the catalogue (`cookout_catalogue.json`): the plain-words `what` line and the `facts`;
- the picture manifest (`cookout_ingredient_images.json`): the sha256 of each card/thumb rendition;
- the object search path: which of those content-addressed files this server actually has.

`snap_extras(id)` is what `_snap_json` (cookout_game.py) adds to every ingredient snapshot; the
snapshot stored in `cookout_turns` never changes. A picture is attached only when BOTH renditions
are present on disk (checked at load and after a self-heal, kept in memory), otherwise `image`
is `None` and the client shows the emoji tile.

`CookoutVisualsService` owns the process-lifetime store work (09b section B.6): the slot pin
registered before anything else touches the store, its lease refresh, the self-heal fetch, the daily
GC and the clean-shutdown retire.

Everything here is engine catalogue data (Inv 58): generated from ingredient names only, never from
chat content, so message delete and chat wipe have nothing of it to erase."""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import cast

import anyio

from wixy_server.livechat.cookout_catalogue import (
    Catalogue,
    load_cookout_catalogue_or_empty,
)
from wixy_server.livechat.cookout_pack import (
    SLOT_REFRESH_S,
    FetchRefused,
    PackError,
    PackManifest,
    PackStore,
    StoreBusy,
    UnknownPin,
    load_manifest,
    object_relpath,
)

_LOGGER = logging.getLogger(__name__)

IMAGE_ROUTE_PREFIX = "/admin/cookout-img/"
_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SELF_HEAL_RETRY_S = 6 * 3600
GC_INTERVAL_S = 24 * 3600
OBJECTS_SUBDIR = Path("cookout-images") / "objects"


def is_sha(value: str) -> bool:
    return _SHA_RE.fullmatch(value) is not None


def search_path(
    storage_root: Path | None, images_dir: Path | None, baked_dir: Path | None
) -> list[Path]:
    """The object search order, first hit wins (B.6): the explicit images dir, the storage objects
    dir, then the baked dir."""
    out: list[Path] = []
    if images_dir is not None:
        out.append(images_dir)
    if storage_root is not None:
        out.append(storage_root / OBJECTS_SUBDIR)
    if baked_dir is not None:
        out.append(baked_dir)
    return out


class IngredientVisuals:
    def __init__(
        self, catalogue: Catalogue, manifest: PackManifest, search: Sequence[Path]
    ) -> None:
        self._catalogue = catalogue
        self._manifest = manifest
        self._search = tuple(search)
        self._lock = threading.Lock()
        self._images: dict[str, dict[str, str]] = {}
        self._served: dict[str, Path] = {}
        self.reload()

    @property
    def manifest(self) -> PackManifest:
        return self._manifest

    @property
    def search(self) -> tuple[Path, ...]:
        return self._search

    def _find(self, sha: str) -> Path | None:
        rel = object_relpath(sha)
        for directory in self._search:
            candidate = directory / rel
            if candidate.is_file():
                return candidate
        return None

    def reload(self) -> None:
        """Re-check which manifest pictures exist here (at load and after a self-heal)."""
        images: dict[str, dict[str, str]] = {}
        served: dict[str, Path] = {}
        for ingredient_id, ref in self._manifest.items.items():
            card = self._find(ref.card)
            thumb = self._find(ref.thumb)
            if card is None or thumb is None:
                continue
            images[ingredient_id] = {
                "card": f"{IMAGE_ROUTE_PREFIX}{ref.card}.webp",
                "thumb": f"{IMAGE_ROUTE_PREFIX}{ref.thumb}.webp",
            }
            served[ref.card] = card
            served[ref.thumb] = thumb
        with self._lock:
            self._images = images
            self._served = served

    def snap_extras(self, ingredient_id: str) -> dict[str, object]:
        entry = self._catalogue.get(ingredient_id)
        what = entry.what if entry is not None and entry.what else None
        image = self._images.get(ingredient_id)
        return {"what": what, "image": dict(image) if image is not None else None}

    def facts(self, ingredient_id: str) -> list[str] | None:
        entry = self._catalogue.get(ingredient_id)
        if entry is None or not entry.facts:
            return None
        return list(entry.facts)

    def resolve_object(self, sha: str) -> Path | None:
        """The file for a manifest sha, or `None` (unknown sha, or the file is missing)."""
        if not is_sha(sha):
            return None
        with self._lock:
            known = sha in self._manifest.shas()
            path = self._served.get(sha)
        if not known:
            return None
        if path is not None and path.is_file():
            return path
        found = self._find(sha)
        if found is not None:
            with self._lock:
                self._served[sha] = found
        return found


def empty_manifest() -> PackManifest:
    return PackManifest(pack_version=0, pack=None, items={}, digest="")


def load_visuals(
    search: Sequence[Path],
    *,
    manifest: PackManifest | None = None,
    catalogue: Catalogue | None = None,
) -> IngredientVisuals:
    """Build the visuals; a bad packaged manifest or catalogue yields the empty one (logged), so the
    game stays playable with emoji tiles and `blurb` lines."""
    if manifest is None:
        try:
            manifest = load_manifest()
        except PackError, OSError, ValueError:
            _LOGGER.exception("Cookout picture manifest unreadable; pictures disabled")
            manifest = empty_manifest()
    if catalogue is None:
        catalogue = load_cookout_catalogue_or_empty()
    return IngredientVisuals(catalogue, manifest, search)


_default: IngredientVisuals | None = None
_default_lock = threading.Lock()


def default_visuals() -> IngredientVisuals:
    """The process's visuals, built lazily once like `default_bank()`. The app replaces it with the
    settings-aware one at start (`set_default_visuals`); before that, the search path comes from the
    same environment variables the settings read (so a bare `python -c` in the container sees the
    baked pictures too)."""
    global _default
    with _default_lock:
        if _default is None:
            root = os.environ.get("WIXY_STORAGE_ROOT")
            images = os.environ.get("WIXY_COOKOUT_IMAGES_DIR")
            baked = os.environ.get("WIXY_COOKOUT_IMAGES_BAKED_DIR")
            _default = load_visuals(
                search_path(
                    Path(root) if root else None,
                    Path(images) if images else None,
                    Path(baked) if baked else None,
                )
            )
        return _default


def set_default_visuals(visuals: IngredientVisuals | None) -> None:
    global _default
    with _default_lock:
        _default = visuals


class CookoutVisualsService:
    """Slot pin, lease refresh, self-heal and GC for one server process (spec B.6)."""

    def __init__(
        self,
        visuals: IngredientVisuals,
        store: PackStore | Callable[[], PackStore],
        *,
        refresh_s: float = SLOT_REFRESH_S,
        self_heal_s: float = SELF_HEAL_RETRY_S,
        gc_s: float = GC_INTERVAL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.visuals = visuals
        # Built lazily (and guarded) so a bad storage root degrades to emoji tiles instead of
        # stopping the app from starting.
        self._store_arg = store
        self._store: PackStore | None = store if isinstance(store, PackStore) else None
        self._store_failed = False
        self._refresh_s = refresh_s
        self._self_heal_s = self_heal_s
        self._gc_s = gc_s
        self._clock = clock
        self.pin_id: str | None = None
        self._next_heal = 0.0
        self._next_gc: float | None = None

    @property
    def store(self) -> PackStore | None:
        if self._store is None and not self._store_failed:
            try:
                factory = cast("Callable[[], PackStore]", self._store_arg)
                self._store = factory()
            except OSError, PackError:
                self._store_failed = True
                _LOGGER.exception("Cookout picture store unavailable; pictures use emoji tiles")
        return self._store

    def register(self) -> None:
        """Register the packaged manifest and write the slot pin. Blocking (file lock); call off the
        event loop. A busy store is logged and retried by the sweep, never fatal."""
        store = self.store
        if store is None:
            return
        try:
            self.pin_id = store.register_slot(self.visuals.manifest)
        except StoreBusy, OSError, PackError:
            _LOGGER.exception("Cookout slot pin not registered; the sweep will retry")

    def retire(self) -> None:
        pin = self.pin_id
        store = self.store
        if pin is None or store is None:
            return
        try:
            store.retire_slot(pin)
        except StoreBusy, OSError, PackError:
            _LOGGER.exception("Cookout slot pin not retired; its lease will lapse")
        self.pin_id = None

    def tick(self) -> None:
        """One sweep step (blocking): refresh or re-register the pin, self-heal, daily GC."""
        now = self._clock()
        store = self.store
        if store is None:
            return
        pinned = self._ensure_pin()
        if now >= self._next_heal:
            self._next_heal = now + self._self_heal_s
            self._self_heal(pinned)
        if self._next_gc is None:
            self._next_gc = now + self._gc_s
        elif now >= self._next_gc:
            self._next_gc = now + self._gc_s
            if not pinned:
                _LOGGER.warning("Cookout picture GC skipped: this server holds no slot pin")
                return
            try:
                store.gc()
            except StoreBusy, OSError, PackError:
                _LOGGER.exception("Cookout picture GC failed")

    def _ensure_pin(self) -> bool:
        """Make sure this server holds a live slot pin: register one if it has none, refresh the
        lease if it has, and register AGAIN if the registry no longer knows the pin (collected
        after a long stall). True when a pin is held. A refresh that merely failed (busy store, a
        transient OS error) still counts as pinned: the pin file is there and a lapsed lease keeps
        its objects for 72 hours."""
        store = self.store
        if store is None:
            return False
        if self.pin_id is None:
            self.register()
            return self.pin_id is not None
        try:
            store.refresh_slot(self.pin_id)
        except UnknownPin:
            _LOGGER.warning(
                "Cookout slot pin %s is gone from the registry; registering again", self.pin_id
            )
            self.pin_id = None
            self.register()
            return self.pin_id is not None
        except StoreBusy, OSError, PackError:
            _LOGGER.exception("Cookout slot pin refresh failed")
        return True

    def _self_heal(self, pinned: bool) -> None:
        manifest = self.visuals.manifest
        store = self.store
        if store is None or manifest.pack is None:
            return
        if not store.missing(manifest, self.visuals.search):
            return
        try:
            written = store.fetch(manifest)
        except FetchRefused:
            _LOGGER.warning("Cookout picture download refused (low disk or busy); retry later")
            return
        except StoreBusy, OSError, PackError:
            _LOGGER.exception("Cookout picture self-heal failed; pictures keep their emoji tiles")
            return
        _LOGGER.info("Cookout picture self-heal wrote %d objects", written)
        self.visuals.reload()
        if not pinned:
            return  # never collect without our own pin protecting what we just fetched
        try:
            store.gc()
        except StoreBusy, OSError, PackError:
            _LOGGER.exception("Cookout picture GC failed")
        self.visuals.reload()

    async def run(self) -> None:
        """The supervised loop: never returns. The first tick (pin + heal check) runs at once, in
        the background, so boot never waits on the store lock; a download in flight is abandoned
        on shutdown instead of holding it up."""
        while True:
            await anyio.to_thread.run_sync(self.tick, abandon_on_cancel=True)
            await anyio.sleep(self._refresh_s)

    async def aretire(self, timeout_s: float = 5.0) -> None:
        """Retire the pin off the event loop with a short bound; a lapsed lease covers a miss."""
        with anyio.CancelScope(shield=True), anyio.move_on_after(timeout_s):
            await anyio.to_thread.run_sync(self.retire, abandon_on_cancel=True)
