#!/usr/bin/env bash
# Prove a built wixy image actually SERVES a baked Cookout picture (spec 09b F.4).
#
#   cookout_image_proof.sh <image> <manifest.json> [container-name]
#
# Boots the image with NOTHING to lean on: `--network none`, a fresh empty /data (no volume), and no
# WIXY_COOKOUT_IMAGES_DIR, so the only possible source of a picture is WIXY_COOKOUT_IMAGES_BAKED_DIR
# (set by the Dockerfile). Everything is asserted from inside the container (`docker exec ... curl`
# to 127.0.0.1, since the network is none):
#   1. a card sha and a thumb sha from <manifest.json> -> 200, image/webp, sha256(body) == the sha;
#   2. an unknown sha -> 404;
#   3. default_visuals().snap_extras(id)["image"] is non-null for every checked id;
#   4. the packaged catalogue loads with the same entry count as the committed one.
# <manifest.json> is the manifest the image was BUILT from. When it has more than five items, ONE
# id is checked, chosen by a seeded draw (COOKOUT_PROOF_SEED, default: the git sha or "0"), so a
# real pack is sampled and a test pack (two ids) is checked in full.
# Runs from the repo root of a checkout with wixy installed (it counts the committed catalogue).
set -euo pipefail

image="${1:?usage: cookout_image_proof.sh <image> <manifest.json> [container-name]}"
manifest="${2:?usage: cookout_image_proof.sh <image> <manifest.json> [container-name]}"
name="${3:-wixy-cookout-proof}"
port=18003
seed="${COOKOUT_PROOF_SEED:-${GITHUB_SHA:-0}}"

docker rm -f "$name" >/dev/null 2>&1 || true
trap 'docker logs "$name" 2>&1 | tail -n 40 || true; docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$name" --network none \
  -e WIXY_EDITION=standalone -e WIXY_CONTAINERIZED=1 \
  -e WIXY_STORAGE_ROOT=/data -e WIXY_PORT="$port" \
  -e WIXY_DEV_NO_AUTH=1 -e WIXY_ENV=dev \
  "$image" >/dev/null

ok=0
for _ in $(seq 1 40); do
  if docker exec "$name" curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
[ "$ok" -eq 1 ] || { echo "cookout proof: /healthz never came up"; exit 1; }

# Choose what to check (ids, then one card + one thumb sha from the first checked id).
picks="$(python - "$manifest" "$seed" <<'PY'
import json
import random
import sys

items = json.load(open(sys.argv[1], encoding="utf-8"))["items"]
ids = sorted(items)
if not ids:
    sys.exit("cookout proof: the manifest has no items - nothing to prove")
checked = ids if len(ids) <= 5 else [random.Random(sys.argv[2]).choice(ids)]
first = items[checked[0]]
print(" ".join(checked))
print(first["card"])
print(first["thumb"])
PY
)"
ids="$(sed -n 1p <<<"$picks")"
card="$(sed -n 2p <<<"$picks")"
thumb="$(sed -n 3p <<<"$picks")"

fetch_and_check() { # <sha>
  local sha="$1" headers body_sha
  headers="$(docker exec "$name" curl -sS -D - -o /tmp/cookout-proof.webp \
    "http://127.0.0.1:${port}/admin/cookout-img/${sha}.webp")"
  grep -q '^HTTP/[0-9.]* 200' <<<"$headers" || { echo "cookout proof: $sha not 200"; echo "$headers"; exit 1; }
  grep -qi '^content-type: image/webp' <<<"$headers" || { echo "cookout proof: $sha not image/webp"; exit 1; }
  body_sha="$(docker exec "$name" sha256sum /tmp/cookout-proof.webp | cut -d' ' -f1)"
  [ "$body_sha" = "$sha" ] || { echo "cookout proof: body sha $body_sha != $sha"; exit 1; }
  echo "cookout proof: $sha served and verified"
}
fetch_and_check "$card"
fetch_and_check "$thumb"

unknown="$(printf '0%.0s' $(seq 1 64))"
status="$(docker exec "$name" curl -sS -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:${port}/admin/cookout-img/${unknown}.webp")"
[ "$status" = "404" ] || { echo "cookout proof: unknown sha gave $status, wanted 404"; exit 1; }

# The visuals the app serves from, and the packaged catalogue, as the image itself loads them.
want_catalogue="$(python -c 'from wixy_server.livechat.cookout_catalogue import load_cookout_catalogue; print(len(load_cookout_catalogue()))')"
docker exec -e CHECK_IDS="$ids" -e WANT_CATALOGUE="$want_catalogue" "$name" python -c '
import os
from wixy_server.livechat.cookout_catalogue import load_cookout_catalogue
from wixy_server.livechat.cookout_visuals import default_visuals

visuals = default_visuals()
for ingredient_id in os.environ["CHECK_IDS"].split():
    image = visuals.snap_extras(ingredient_id)["image"]
    assert image is not None, f"no baked picture for {ingredient_id}"
got, want = len(load_cookout_catalogue()), int(os.environ["WANT_CATALOGUE"])
assert got == want, f"packaged catalogue has {got} entries, committed has {want}"
print("cookout proof: visuals + catalogue ok")
'
echo "cookout proof: PASS ($image)"
