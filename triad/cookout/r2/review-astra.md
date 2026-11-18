# Cookout 09b — independent Astra review

Reviewed the full `spec/server-chat/09b-cookout-visual.md` against checkout
`64a0747a13b296e32f475d64d77d2dc7f8e8c023`, after fetching and merging
`origin/cmd/workspace-00058` (already up to date).

**7 high, 0 critical.** Line references below are to that revision. These are
specification defects, not claims that the proposed visual implementation already exists.

## 1. High — pack GC can delete the pack being installed and packs still in service

**Section/line:** §B.6, lines 365–389; frozen `gc_objects` interface, line 895.

**Problem:** Only server *startup* records a manifest and refreshes its `seenAt`.
GC after `install` or self-heal deletes objects not referenced by a manifest seen
within 14 days. Installation is explicitly required *before* the manifest merges,
so no server has yet registered that new manifest. Nor does a server remaining
up for more than 14 days refresh its record. A recent startup timestamp is not
proof that a manifest is the complete set currently in use. The contract also
does not serialize GC against another slot's install or manifest registration.

**Failure scenario:** The tooling installs v2 before its PR merges, then runs the
specified GC. New v2-only objects have no registered reference and are deleted.
Alternatively, an old slot has run v1 for 15 days when v2 is installed; GC removes
v1-only files while the old slot is still serving. Its cached presence decisions
(§E.1, lines 660–662) remain true, but its image requests return 404. This defeats
the stated blue/green guarantee even with a valid archive and successful install.

**Exact fix:** Freeze a cross-process installation/GC protocol. Under one storage
lock, register and protect the incoming manifest *before* making any of its
objects eligible for GC. Pin manifests used by live slots independently of the
14-day historical-retention clock; refresh a per-slot lease or read an authoritative
active-slot set, and retire a pin only when that slot stops serving. Protect
pending manifest deliveries until activated or explicitly cancelled. Compute GC's
keep set from active, pending and recently retired manifests while holding the
same lock. Key records by manifest digest as well as pack version. Add tests for
pre-merge installation, a slot older than 14 days, concurrent install/GC, and an
overlapping old/new slot.

## 2. High — deleting all but two releases breaks pinned builds and recovery

**Section/line:** §B.6, lines 313–330, 375–385.

**Problem:** The manifest makes a release asset a required, hash-pinned build
input, then the retention rule deletes that input once two newer packs exist.
Forks and historical source revisions retain their own manifests; publishing v3
does not update them. Content addressing cannot recover bytes from a deleted URL.
The existing image workflow builds the checked-out source and Dockerfile
(`.github/workflows/publish-image.yml:49–57`), not whichever manifest happens to
be newest upstream.

**Failure scenario:** An owner's fork still pins v1 when upstream publishes v3.
Her next unrelated image build downloads the v1 URL and fails with 404. A clean
rebuild of an older revision, or self-heal of an older bare-server deployment,
fails the same way. Retaining the previous *upstream* pack does not preserve the
pack required by that deployment.

**Exact fix:** Never automatically delete a released pack referenced by a shipped
manifest. Retain these immutable release assets indefinitely, or place them in a
durable archive whose stable URL is already usable by every supported pinned
manifest before deleting the original. Limit local object-cache retention instead.
Require a regression proof that the v1 manifest still fetches and installs from a
clean environment after publishing v2 and v3.

## 3. High — automatic pack downloads bypass disk admission and have no byte ceiling

**Section/line:** §B.6, lines 337–340, 352–389; §F.1, lines 715–718;
`fetch_pack`, lines 892–895.

**Problem:** The archive has a declared `bytes` value, but the download contract
only requires checksum verification after downloading. It specifies neither an
enforced streaming limit nor admission for the archive plus extracted objects,
temporary files and overlapping slots. It only explicitly deletes the tar on
success. The new store shares the storage volume but lies outside the existing
chat-media accounting. Existing picture admission explicitly checks the free-space
floor (`wixy_server/app.py:393–400`); the proposed pack path does not inherit that
check merely by using the same disk.

**Failure scenario:** On a storage-constrained server, a legitimate approximately
150 MB archive fits, but installing its approximately 150 MB of new objects does
not. The automatic self-heal consumes the remaining space used by the live server
and its database. A mirror returning more than the advertised archive size can
fill the volume before the eventual hash mismatch, and failed incoming files can
survive into subsequent six-hour retries. A checksum is an integrity check, not a
disk-space bound.

**Exact fix:** Make `pack.bytes` mandatory and bounded for every nonempty pack;
stream to a uniquely named temporary file, reject the first byte beyond that
length, require the exact final length, and enforce a total deadline. Specify a
bounded object/member count and total installed bytes. Before download/install,
reserve enough space for the archive, new objects and temporary overhead above
the server's free-space floor, with one cross-process reservation/install lock.
Keep this catalogue budget separate from the chat-media quota. Clean partial
downloads on every exit and reclaim stale incoming files after crashes. Add
oversized/chunked response, low-space, interrupted fetch and overlapping-startup
tests. On refusal, preserve existing objects and serve the documented fallback.

## 4. High — the promised phone geometry cannot satisfy its own minimums

**Section/line:** §D.1–D.3, lines 520–587; §D.6, lines 624–626; §F.3,
lines 752–759.

**Problem:** The specified fixed rows with twists total 304 px. The minimum stage
is another 168 px (96 px image plus the prescribed 72 px text allowance). The
existing frame additionally has a 44 px phone tab bar plus its border, and already
owns `safe-area-inset-bottom` (`admin-ui/src/server/chat.css:1126–1155`). Line 559
adds the same inset a second time under the chat row. With a 34 px inset, the
minimum is therefore **304 + 168 + 45 + 68 = 585 px**, even before pane margins
and gutters. It cannot fit the promised 560 px portrait viewport, where compact
mode does not apply. The compact rows similarly require at least **505 px** at
the promised 480 px boundary. An incoming/connected call also restores the chat
header above the game (`chat.css:1182–1193`), without changing the viewport-height
breakpoint.

The interaction minimums also conflict: two rows of tappable thumbnails cannot
fit non-overlapping 44 px targets into a 64 px progress row; the compact single
row cannot hold nine visible picked items with 44 px targets across a 360 px
screen. Merely clipping overflow would conceal the failure.

**Failure scenario:** A short phone with twists and a home-indicator inset clips
the cards or actions, shrinks pictures below the promised minimum, or scrolls.
An incoming call can produce the same loss of room on a taller phone. The proposed
360×640/390×844 tests omit the 560/480 boundaries, nonzero safe areas and live-call
header. Their overflow check also excludes clipped descendants, so hiding content
can produce a passing no-scroll result.

**Exact fix:** Make the existing tab bar the sole owner of the bottom inset and
budget against the *actual game pane's available height*, including the live-call
header. Freeze achievable row sizes and container-height compact thresholds.
Either give each interactive progress row at least 44 px, or make compact thumbs
passive and provide one 44 px basket/popover control. Keep the call controls
visible. Test 360×560 and 360×480 in addition to the existing baselines, with a
controlled 34 px inset, every twist, long text and a non-idle call. Assert that
all required content and controls are unclipped and hit-testable, their targets
do not overlap, and the image minimum holds; do not equate hidden overflow with
successful fit. Assign any required shared-frame changes explicitly to one owner.

## 5. High — the three mandatory seasoning entries have no source for required catalogue fields

**Section/line:** §A.1, lines 69–80; §A.3, lines 142–144; §A.4,
lines 212–216; exclusion boundary, lines 5–6.

**Problem:** All 3,494 entries must have a current `nameKey` computed from name,
aliases and category, and author input must include category name, role and
blurb. But the three seasoning-only bank records contain exactly `id`, `name`
and `pickable`. `Staple` has only those fields
(`wixy_server/livechat/cookout_bank.py:151–155`); only `Ingredient` has the other
fields (`:158–169`). Direct inspection confirms 3,491 ingredients and the three
seasoning-only records `water`, `salt`, `black-pepper`. The count is correct;
the required source metadata does not exist. No normalization rule supplies it.

**Failure scenario:** The catalogue builder handles ordinary ingredients but
cannot construct the mandatory author input or the specified staleness key for
the last three entries. One parcel invents categories/defaults while another
validates differently, so the complete catalogue cannot pass acceptance.
Adding fields to the source bank to make the contract work would also enter the
separate chef-fix parcel's explicitly owned files.

**Exact fix:** Define one readonly `CatalogueSubject` adapter in parcel 1, shared
by authoring and validation. Freeze explicit metadata for these three IDs, such
as empty aliases, `accent` role, empty blurb, and a specified category/category
name for each, and state exactly how these synthetic values enter `nameKey`.
Alternatively define a distinct staple key formula and optional author-input
fields, consistently across all consumers. Test both ordinary and seasoning-only
records. Make no changes to `cookout_bank.py`, `cookout_ingredients.json`,
`cookout_ai.py` or `fake_cmd.py` to solve this visual-parcel issue.

## 6. High — calibration can approve a checker without an agreed result on its sample

**Section/line:** §C.3.5–6, lines 484–495; §F.1, lines 731–733.

**Problem:** Judge disagreements are excluded as `contested`, but checker
eligibility is only “at most 2 errors against agreed truth”, no wrong-food false
accepts, and every decoy caught. There is no minimum number of agreed sample
results and no requirement to resolve disputed accepts. The fixed “on its 50”
wording does not define how contested rows count. Moreover, stage-2 truth has no
`problems` field, although the rule needs a defined source for the `wrong_food`
classification when a judge changes its verdict.

**Failure scenario:** Haiku accepts ambiguous or wrong real images on which the
two judges disagree, but catches the obvious cross-category decoys. The disputed
accepts contribute no errors, so it qualifies for the full run. In the limiting
case, zero agreed sample results means zero errors and zero established
wrong-food false accepts: all stated conditions still pass. The proposed rule
can therefore select the checker without establishing the claimed sample
accuracy.

**Exact fix:** Freeze a total decision rule for all 50 assigned images. Resolve
judge disagreements with an independent adjudication before selection, or make
any unresolved case render that checker ineligible and take the already specified
operator-decision path. Keep `unclear` distinct in the report and define how it
counts. Include final problem tags in the judge/adjudicator schema so a final
`wrong_food` false accept is computable without guessing from prose or a
superseded verdict. Test all-contested, mostly-contested, disputed false accepts
and changed stage-2 problem tags; none may qualify through an empty denominator.

## 7. High — “image-boot proof green” does not prove baked pictures are served

**Section/line:** §B.6, lines 375–380; §E.4, lines 697–700; §F.1/F.3;
§G.1, lines 793–797; §G.4.4, lines 936–937.

**Problem:** The existing image-boot proof only polls `/healthz` and checks the
edition in `/api/version` for each container
(`.github/workflows/ci.yml:184–217`). It never requests a Cookout image or checks
the baked object path. The proposed e2e test instead uses an override directory
and placeholder bytes, so it cannot establish that the installed Docker package
loads its manifest and resolves `/app/cookout-pack/objects`. No parcel owns an
extension of the CI image proof, despite that proof being the stated standalone
acceptance gate. The documented fallbacks mean health remains green when this
entire picture path is broken.

**Failure scenario:** The archive downloads and verifies at build time, but the
runtime baked-directory setting or installed manifest lookup is wrong. All
ingredient images are null/404 in the standalone container while its health,
edition checks and override-directory e2e tests pass. The round is declared done
under the written gate and every standalone user receives emoji fallbacks.

**Exact fix:** Assign the image-proof change explicitly, for example parcel 3 owns
the relevant `.github/workflows/ci.yml` assertions and its narrow smoke script.
For a nonempty manifest, boot the actual built image with empty runtime storage,
no image-directory override and no runtime network dependency. Request at least
one card and one thumb from that manifest and verify HTTP 200, MIME type and the
response bytes' SHA-256 against the manifest. Check the packaged catalogue too.
For the initial empty manifest, use a small deterministic test pack with a
matching digest to exercise the same build/install/runtime path, then repeat
against the published pack in its final gate. Copy both `cookout_pack.py` and the
manifest explicitly before the pre-`COPY wixy_server/` fetch step. Keep these
proof fixtures separate from the chef-fix-owned `wixy_server/tests/fake_cmd.py`.
