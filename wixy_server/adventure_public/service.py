"""`AdventurePublicService`: everything the public Adventure Time host needs, built once by
`create_app` when `WIXY_ADVENTURE_PUBLIC_HOST` is set (spec/adventure-public/README.md §2).

It owns the public bank (with its short codes), the pack cache store, the research runner, the
picture job (when a finder is configured), the start limiter and the page shell;
`routes_adventure_public` serves it and `app.create_app` wires its lifespan (prepare the
folders, resume what the previous process left `pending`, supervise the picture sweep) and
installs the host gate in front of everything else.
"""

from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, TypeVar

import anyio
import anyio.to_thread
from anyio import CapacityLimiter

from wixy_server.adventure_public.codes import PublicBank, build_public_bank
from wixy_server.adventure_public.limits import PublicLimits, StartLimiter
from wixy_server.adventure_public.pictures import PublicPictureJob
from wixy_server.adventure_public.runner import PublicPackRunner
from wixy_server.adventure_public.shell import AssetTable, PublicShell
from wixy_server.adventure_public.store import PublicPackStore
from wixy_server.livechat.adventure_bank import AdventureBank
from wixy_server.livechat.adventure_pack import AdventureResearcher, PackTiming
from wixy_server.livechat.adventure_pictures import (
    AdventurePictureFinder,
    PictureTiming,
    WebPictureFinder,
)
from wixy_server.storage import ProjectPaths

BUILTIN_ASSETS_DIR = Path(__file__).parent / "assets"
PUBLIC_THREAD_LIMIT: Final = 6
"""How many worker threads the public routes may hold at once (see `PublicThreads`)."""

_T = TypeVar("_T")


class PublicThreads:
    """The public host's OWN worker-thread budget (`CapacityLimiter(6)`).

    A blocking call on the public routes (a database read, a file read, a directory look) runs on a
    thread; anyio's default pool is ONE process-wide limiter (40 threads) shared with every private
    chat route, so an anonymous flood of public requests could take every thread and starve the
    private chat. Every thread call on the public side goes through `run`, which passes this
    limiter, so a flood queues behind these six tokens and the default pool stays the private
    chat's.

    The limiter is made ONCE, here. Made outside an event loop, anyio returns an adapter that binds
    to the loop on its first use, so this is safe at app construction. It used to be made lazily on
    first read, and two threads reading it at the same moment each made one: work parked on one
    limiter was never woken by tokens given back to the other (an intermittent CI hang,
    decisions/00216 addendum)."""

    def __init__(self, size: int = PUBLIC_THREAD_LIMIT) -> None:
        self._limiter: CapacityLimiter = CapacityLimiter(size)

    @property
    def limiter(self) -> CapacityLimiter:
        return self._limiter

    async def run(self, fn: Callable[..., _T], *args: object) -> _T:
        return await anyio.to_thread.run_sync(fn, *args, limiter=self.limiter)


@dataclass(slots=True)
class PublicStatus:
    """Whether the public store prepared at start (its folders and schema). Until it has, every
    public page and API route answers 503 and creates nothing."""

    ready: bool = False


@dataclass(frozen=True, slots=True)
class AdventurePublicService:
    host: str
    bank: PublicBank
    store: PublicPackStore
    runner: PublicPackRunner
    pictures: PublicPictureJob | None
    limiter: StartLimiter
    assets: AssetTable
    shell: PublicShell
    pictures_dir: Path
    owned_finder: WebPictureFinder | None
    """The production picture finder this service built itself (closed with the app); `None` when
    one was injected or there is none."""
    threads: PublicThreads = field(default_factory=PublicThreads)
    status: PublicStatus = field(default_factory=PublicStatus)

    def prepare(self) -> None:
        """Create the folders and the database now (blocking; call from a thread): the pictures
        folder, cmd's empty working folder and the schema."""
        self.pictures_dir.mkdir(parents=True, exist_ok=True)
        self.runner.prepare_directory()
        self.store.initialise()
        self.status.ready = True

    async def aclose(self) -> None:
        if self.owned_finder is not None:
            await self.owned_finder.aclose()


def build_adventure_public(
    *,
    host: str,
    paths: ProjectPaths,
    bank: AdventureBank,
    researcher: AdventureResearcher | None,
    finder: AdventurePictureFinder | None,
    owned_finder: WebPictureFinder | None,
    pack_timing: PackTiming | None,
    picture_timing: PictureTiming | None,
    limits: PublicLimits | None,
    min_free_bytes: int,
    bundle_dir: Path,
    shared_dir: Path,
) -> AdventurePublicService:
    """Assemble the service. `finder`/`researcher` are what `create_app` resolved (injected, or the
    production defaults on the fleet's cmd backend); `None` means a pack has no pictures / cannot be
    researched. Nothing here touches the disk: `prepare()` does."""
    public_bank = build_public_bank(bank)
    store = PublicPackStore(
        paths.adventure_public_db,
        cache_limit=sum(len(unit.destinations) for unit in bank.units.values()),
    )
    pictures_dir = paths.adventure_public_pictures

    def _space_ok(size_bytes: int) -> bool:
        probe = paths.root if paths.root.exists() else paths.root.parent
        return shutil.disk_usage(probe).free - size_bytes >= min_free_bytes

    pictures = (
        PublicPictureJob(
            store=store,
            pictures_dir=pictures_dir,
            bank=bank,
            finder=finder,
            space_ok=_space_ok,
            timing=picture_timing,
        )
        if finder is not None and researcher is not None
        else None
    )
    runner = PublicPackRunner(
        store=store,
        bank=bank,
        researcher=researcher,
        cwd=paths.adventure_public_research,
        timing=pack_timing,
        pictures=pictures,
    )
    assets = AssetTable(
        bundle_dir=bundle_dir, shared_dir=shared_dir, builtin_dir=BUILTIN_ASSETS_DIR
    )
    return AdventurePublicService(
        host=host,
        bank=public_bank,
        store=store,
        runner=runner,
        pictures=pictures,
        limiter=StartLimiter(limits),
        assets=assets,
        shell=PublicShell(host=host, assets=assets),
        pictures_dir=pictures_dir,
        owned_finder=owned_finder,
    )
