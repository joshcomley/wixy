"""Ingredient visuals with no pictures and no catalogue, for tests that call the Cookout view
builders directly (`cookout_view_json`, `bank_entry_json`): they take their visuals explicitly, so
a test that builds an app can no longer leave pictures behind for the next one."""

from __future__ import annotations

from wixy_server.livechat.cookout_catalogue import Catalogue
from wixy_server.livechat.cookout_visuals import IngredientVisuals, empty_manifest


def no_visuals() -> IngredientVisuals:
    return IngredientVisuals(Catalogue(), empty_manifest(), [])
