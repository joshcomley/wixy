"""`create_app` installs the Cookout visuals as the PROCESS default (`set_default_visuals`), so a
test that builds an app used to leave them behind for the next test in that worker: CI on the pack
v2 data PR failed two Cookout tests that way (the staple "water" carried a real picture where the
test expected none). conftest.py's autouse fixture resets the default around every test. An inner
pytest run with a FIXED order (the outer suite is shuffled by pytest-randomly) proves it: the same
two tests fail without the fixture and pass with it."""

from __future__ import annotations

import pytest

pytest_plugins = ["pytester"]

_TESTS = """
from wixy_server.livechat import cookout_visuals


def test_a_installs_a_default():
    cookout_visuals.set_default_visuals(cookout_visuals.load_visuals([]))
    assert cookout_visuals._default is not None


def test_b_starts_with_none():
    assert cookout_visuals._default is None
"""

_FIXTURE = """
import pytest

pytest_plugins = ["pytester"]
from wixy_server.tests.visuals_isolation import isolated_default_visuals


@pytest.fixture(autouse=True)
def _isolate():
    yield from isolated_default_visuals()
"""


def test_without_the_reset_a_default_leaks_into_the_next_test(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(test_inner=_TESTS)
    result = pytester.runpytest_inprocess("-p", "no:randomly", "-p", "no:cacheprovider")
    result.assert_outcomes(passed=1, failed=1)


def test_with_the_reset_the_next_test_starts_clean(pytester: pytest.Pytester) -> None:
    pytester.makeconftest(_FIXTURE)
    pytester.makepyfile(test_inner=_TESTS)
    result = pytester.runpytest_inprocess("-p", "no:randomly", "-p", "no:cacheprovider")
    result.assert_outcomes(passed=2)
