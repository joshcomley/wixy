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
from dataclasses import dataclass
from pathlib import Path

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

    def prepare(self) -> None:
        """Create the folders and the database now (blocking; call from a thread): the pictures
        folder, cmd's empty working folder and the schema."""
        self.pictures_dir.mkdir(parents=True, exist_ok=True)
        self.runner.prepare_directory()
        self.store.initialise()

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
    store = PublicPackStore(paths.adventure_public_db)
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
        bank=build_public_bank(bank),
        store=store,
        runner=runner,
        pictures=pictures,
        limiter=StartLimiter(limits),
        assets=assets,
        shell=PublicShell(host=host, assets=assets),
        pictures_dir=pictures_dir,
        owned_finder=owned_finder,
    )
