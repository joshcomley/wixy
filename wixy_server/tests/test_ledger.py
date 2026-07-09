from __future__ import annotations

import json
from pathlib import Path

import pytest

from wixy_server.ledger import LedgerEntry, append_ledger, find_version, next_version, read_ledger
from wixy_server.storage import ProjectPaths, project_paths


@pytest.fixture
def paths(tmp_path: Path) -> ProjectPaths:
    return project_paths(tmp_path, "test")


def _publish_entry(version: int, sha: str) -> LedgerEntry:
    return LedgerEntry(
        version=version,
        sha=sha,
        when="2026-07-10T09:00:00+00:00",
        message="Content update via Wixy editor",
        source="editor",
        changed={"index": ["hero.title"]},
    )


class TestReadLedger:
    def test_empty_when_no_file(self, paths: ProjectPaths) -> None:
        assert read_ledger(paths) == []

    def test_ignores_blank_lines(self, paths: ProjectPaths) -> None:
        paths.publishes_jsonl.parent.mkdir(parents=True)
        paths.publishes_jsonl.write_text(
            json.dumps(_publish_entry(1, "a" * 40).to_dict()) + "\n\n", encoding="utf-8"
        )
        assert len(read_ledger(paths)) == 1


class TestAppendLedger:
    def test_appends_a_publish_entry_and_reads_it_back(self, paths: ProjectPaths) -> None:
        entry = _publish_entry(1, "a" * 40)
        append_ledger(paths, entry)
        assert read_ledger(paths) == [entry]

    def test_appends_are_ordered_oldest_first(self, paths: ProjectPaths) -> None:
        first = _publish_entry(1, "a" * 40)
        second = _publish_entry(2, "b" * 40)
        append_ledger(paths, first)
        append_ledger(paths, second)
        assert [e.version for e in read_ledger(paths)] == [1, 2]

    def test_a_restore_entry_round_trips_with_action_and_of(self, paths: ProjectPaths) -> None:
        restore_entry = LedgerEntry(
            version=3, sha="a" * 40, when="2026-07-10T10:00:00+00:00", action="restore", of=1
        )
        append_ledger(paths, restore_entry)
        entries = read_ledger(paths)
        assert entries == [restore_entry]
        assert entries[0].message is None
        assert entries[0].source is None

    def test_publish_and_restore_entries_coexist_in_one_file(self, paths: ProjectPaths) -> None:
        publish1 = _publish_entry(1, "a" * 40)
        publish2 = _publish_entry(2, "b" * 40)
        restore = LedgerEntry(
            version=3, sha="a" * 40, when="2026-07-10T11:00:00+00:00", action="restore", of=1
        )
        for entry in (publish1, publish2, restore):
            append_ledger(paths, entry)
        assert read_ledger(paths) == [publish1, publish2, restore]

    def test_fsyncs_so_the_write_is_durable(self, paths: ProjectPaths) -> None:
        # Not directly observable from Python after the fact, but this at minimum
        # proves append_ledger doesn't raise when asked to fsync a real file.
        append_ledger(paths, _publish_entry(1, "a" * 40))
        assert paths.publishes_jsonl.exists()


class TestFindVersion:
    def test_finds_an_existing_version(self, paths: ProjectPaths) -> None:
        append_ledger(paths, _publish_entry(1, "a" * 40))
        append_ledger(paths, _publish_entry(2, "b" * 40))
        found = find_version(paths, 2)
        assert found is not None
        assert found.sha == "b" * 40

    def test_returns_none_for_an_unknown_version(self, paths: ProjectPaths) -> None:
        append_ledger(paths, _publish_entry(1, "a" * 40))
        assert find_version(paths, 99) is None


class TestNextVersion:
    def test_is_1_when_the_ledger_is_empty(self, paths: ProjectPaths) -> None:
        assert next_version(paths) == 1

    def test_is_one_past_the_highest_recorded_version(self, paths: ProjectPaths) -> None:
        append_ledger(paths, _publish_entry(1, "a" * 40))
        append_ledger(paths, _publish_entry(2, "b" * 40))
        assert next_version(paths) == 3

    def test_a_restore_still_advances_the_next_version(self, paths: ProjectPaths) -> None:
        append_ledger(paths, _publish_entry(1, "a" * 40))
        append_ledger(
            paths,
            LedgerEntry(
                version=2, sha="a" * 40, when="2026-07-10T12:00:00+00:00", action="restore", of=1
            ),
        )
        assert next_version(paths) == 3
