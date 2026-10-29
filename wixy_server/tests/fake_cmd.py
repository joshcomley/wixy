"""A fake cmd server (spec/06-ai-chat.md §4: "cmdchat.py is written against an
interface so tests run against a fake cmd server... including the
handover-resolution and mid-provisioning states") — one combined FastAPI app
standing in for BOTH real cmd surfaces `wixy_server.cmdchat` talks to (the cmd
portal on 9320, Cmd-Chats introspection on 9321): since `httpx.ASGITransport`
dispatches purely by path (never by host/port), one app can serve both route
groups for the plain-HTTP endpoints. The `/ws/chat-pending` websocket needs a real
socket (ASGI transports can't do the upgrade), so websocket-exercising tests spin
this same app up via a real ephemeral-port uvicorn instance (`start_fake_cmd_server`
below) instead.

Not a `test_*.py` file — a reusable fixture module, imported by test files, never
collected by pytest itself (mirrors `e2e/fixture_server.py`'s own non-test-prefixed
convention).
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from builder.jsontypes import JsonObject

DEFAULT_UPLOAD_BYTES = (
    b"RIFF8\x00\x00\x00WEBPVP8 ,\x00\x00\x00\x90\x01\x00\x9d\x01*\x08\x00\x08\x00"
    b"\x01@&%\xa0\x02t\xba\x00\x03\x98\x00\xfe\xeev\x7f\xfe\xa0\xcf\xfc\x83?\xf2\x0c"
    b"\xfdT\xbfjQ\x05%l\x00\x00"
)
"""A real 8x8 WEBP (Pillow-generated) served by the fake's
`GET /api/uploads/{id}/bytes` — genuine decodable bytes so a browser `<img>`
pointed at wixy's bytes proxy actually loads in E2E (decisions/00110)."""


@dataclass
class FakeSession:
    session_id: str
    workspace_id: str | None
    prompt: str
    cmd_project: str = ""
    model: str | None = None
    """The `model` the create call asked for (`None` = field omitted) — tests
    assert Wixy pins Sonnet 5 rather than inheriting cmd's own default (Opus).
    """
    spawned_by_session_id: str | None = None
    """The raw `spawned_by_session_id` the create call sent. `""` is cmd's
    "deliberately unparented" sentinel and is what Wixy must send; the handler
    below rejects an omitted/null value with a 400 exactly as cmd does, so this
    is never `None` for a session that actually got created."""
    ready: bool = False
    ready_after_polls: int = 0
    poll_count: int = 0
    chain: list[str] = field(default_factory=list)
    messages: list[JsonObject] = field(default_factory=list)
    status: JsonObject = field(
        default_factory=lambda: {
            "activity": None,
            "process": {"kind": "cli"},
            "handover_state": None,
        }
    )
    send_status_code: int = 202
    send_buffered: bool = False
    idempotency_seen: dict[str, int] = field(default_factory=dict)
    """`idempotency_key -> send call count` — tests assert a retried send with the
    SAME key was only ever accepted once by inspecting this, matching spec/06 §1's
    "Include the idempotency key so a UI retry can't double-send.\""""
    last_send_body: JsonObject | None = None
    """decisions/00103: the exact JSON body the most recent `/send` call carried —
    lets a test assert on the `attachments` field (present with the right
    `{kind, upload_id}` shape, or absent entirely for a plain text send) without
    a bespoke request-capturing middleware."""
    create_attachments: list[JsonObject] | None = None
    """decisions/00110: the `attachments` list the new-chat call carried (None =
    field omitted) — cmd's own new-chat route folds these into the first turn
    (its `_stage_new_chat_attachments`), and tests assert wixy forwards them."""


@dataclass
class FakePinApp:
    """spec/server-chat/00-brief.md §5.1 v1.4: one app-key's registered test PIN
    plus cmd's own per-subject lockout state — mirrors the REAL contract
    (`POST /api/pins/<app_key>/verify` -> `{"ok", "error"?, "attempts_left"?,
    "locked"?, "lock_scope"?, "retry_after_seconds"?}`) closely enough that
    `livechat.pinclient.CmdPinVerifier`'s mapping logic is exercised against
    something that actually behaves like cmd, not a rubber stamp. Only
    per-SUBJECT lockout is modeled — cmd's own app-wide ladder isn't, since
    wixy's client never branches on `lock_scope` (§5.1: "not surfaced to the
    browser")."""

    app_key: str
    pin: str
    lockout_after: int = 5
    """5 wrong attempts -> locked (matches cmd's own stated default ladder,
    §5.1: "5 wrong in a row per subject -> 60s, doubling...")."""
    lockout_seconds: float = 60.0
    attempts: dict[str, int] = field(default_factory=dict)  # subject -> wrong-attempt count
    locked_until: dict[str, float] = field(default_factory=dict)  # subject -> epoch
    simulate_pin_changed_once: bool = False
    """When true, the NEXT `verify` call for this app returns 409 `pin_changed`
    (§5.1 v1.4) instead of evaluating the PIN, then resets itself — a test sets
    this to exercise wixy's 409 mapping without needing a real PIN rotation."""


@dataclass
class FakeTranscribeRequest:
    """One `POST /api/transcribe` the fake received: what wixy actually put on the wire."""

    audio: bytes
    filename: str | None
    content_type: str | None
    fields: dict[str, str]
    """Every non-file form field, verbatim — tests assert wixy sends exactly `private=1` and
    `cleanup=0` and never a `session_id` or `context`."""


CANNED_ADVENTURE_PACK: JsonObject = {
    "headline": "Sun, tiles and custard tarts on the Atlantic edge of Europe",
    "summary": "A hilly, walkable capital with trams, viewpoints and a famous food scene, "
    "close to beaches and fairytale palaces.",
    "wikipedia": "Lisbon",
    "sections": [
        {
            "key": "food",
            "title": "Food",
            "items": [
                {
                    "name": "Pasteis de nata",
                    "detail": "The custard tart every bakery sells; eat one warm with cinnamon.",
                    "url": "https://example.com/food/pasteis",
                    "wikipedia": "Pastel de nata",
                },
                {
                    "name": "Grilled sardines",
                    "detail": "A summer street-party classic.",
                    "url": None,
                    "wikipedia": None,
                },
            ],
        },
        {
            "key": "stay",
            "title": "Where to stay",
            "items": [
                {
                    "name": "A tiled townhouse in Alfama",
                    "detail": "Quiet rooms under the castle walls.",
                    "url": "https://example.com/stay/alfama",
                    "wikipedia": None,
                }
            ],
        },
        {
            "key": "sights",
            "title": "Sights",
            "items": [
                {
                    "name": "Belem Tower",
                    "detail": "A riverside fortress.",
                    "url": None,
                    "wikipedia": "Belém Tower",
                }
            ],
        },
    ],
    "bestTime": "April to June and September to October.",
    "gettingThere": "Direct flights from most UK airports, about two and a half hours.",
    "travelAdvice": "The UK government advises no restrictions for Portugal.",
    "sources": [{"title": "Visit Portugal", "url": "https://example.com/visit"}],
}
"""A valid holiday pack as the research model would return it (spec/server-chat/08 §4.3) — the
default final answer of the fake chat-spawn runs, and what the e2e fixture serves."""


BASKET_MARKER = "BASKET_JSON: "
CONCEPT_MARKER = "CONCEPT_JSON: "
"""The single-line JSON markers `wixy_server.livechat.cookout_ai`'s prompts carry (duplicated here
on purpose: the fake stands in for cmd and must not import the code under test)."""


def _marked_json(prompt: str, marker: str) -> dict[str, Any] | None:
    for line in prompt.splitlines():
        if line.startswith(marker):
            value = json.loads(line[len(marker) :])
            return value if isinstance(value, dict) else None
    return None


def _join_names(names: list[str]) -> str:
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


_CHALLENGE_NOTES = {
    "one-pan": "Everything cooks together in one single pan.",
    "no-oven": "Made entirely on the hob or under the grill.",
    "thirty-minutes": "Ready from start to table in half an hour.",
    "six-steps": "A short method of just a few easy steps.",
}
"""The fake chef's `challengeNote` per challenge id (duplicated on purpose, like the markers; no
food word and no oven word, so it passes every deterministic check)."""


def canned_cookout_concepts(prompt: str) -> dict[str, Any] | None:
    """A valid Stage-1 answer for the ten- or eleven-ingredient basket in `prompt`: three concepts
    using ids[0:8], ids[N-8:N] and ids[0:7] (so every pick is used, one concept uses 8, each uses
    7+) with three distinct (dishType, technique) pairs, naming only foods the concept uses. The
    prompt's `twists` object (if any) is honoured: every star is used in every concept (its name is
    in the description), the wildcard in the first two, and each challenge's rule is kept."""
    basket = _marked_json(prompt, BASKET_MARKER)
    if basket is None:
        return None
    raw = basket.get("ingredients")
    if not isinstance(raw, list) or len(raw) not in (10, 11):
        return None
    records = [r for r in raw if isinstance(r, dict)]
    ids = [str(r["id"]) for r in records]
    names = {str(r["id"]): str(r["name"]) for r in records}
    twists = basket.get("twists")
    twists = twists if isinstance(twists, dict) else {}
    stars = [str(i) for i in twists.get("stars") or []]
    wildcard = twists.get("wildcard")
    challenge = twists.get("challenge")
    last = ("bake", "roast", "Golden")
    if challenge == "no-oven":
        last = ("platter", "grill", "Quick")
    plan = [
        ("a", ids[0:8], "Sunday Supper", "stew", "simmer", "Slow-simmered"),
        ("b", ids[len(ids) - 8 :], "Fresh and Light", "salad", "no-cook", "Bright"),
        ("c", ids[0:7], "Weeknight Comfort", last[0], last[1], last[2]),
    ]
    concepts: list[dict[str, Any]] = []
    for position, (cid, window, vibe, dish_type, technique, adjective) in enumerate(plan):
        wanted = set(window) | set(stars)
        if isinstance(wildcard, str) and position < 2:
            wanted.add(wildcard)
        used = [i for i in ids if i in wanted]
        omitted = [i for i in ids if i not in used]
        lead = [names[i] for i in used[:2]]
        concept: dict[str, Any] = {
            "id": cid,
            "title": f"{adjective} {_join_names(lead)} {dish_type.capitalize()}",
            "vibe": vibe,
            "dishType": dish_type,
            "technique": technique,
            "description": (
                f"A simple supper for two built around {_join_names([names[i] for i in used])}"
                ", finished with a pinch of salt and black pepper."
            ),
            "pickedIngredientIds": list(used),
            "stapleIds": ["salt", "black-pepper"],
            "omitted": [
                {"id": i, "reason": "Saved for another night so this dish stays focused."}
                for i in omitted
            ],
        }
        if isinstance(challenge, str):
            concept["challengeNote"] = _CHALLENGE_NOTES.get(challenge, "Keeps to the rule.")
            if challenge == "thirty-minutes":
                concept["totalMinutes"] = 25
        concepts.append(concept)
    return {"concepts": concepts}


def canned_cookout_recipe(prompt: str) -> dict[str, Any] | None:
    """A valid Stage-2 answer covering exactly the manifest in `prompt` (and, when the prompt's
    `twists` object names a challenge, a `cookware` list and a method that keeps the rule)."""
    concept = _marked_json(prompt, CONCEPT_MARKER)
    manifest = concept.get("manifest") if concept is not None else None
    if not isinstance(manifest, dict):
        return None
    items = [
        i
        for key in ("ingredients", "staples")
        for i in (manifest.get(key) or [])
        if isinstance(i, dict)
    ]
    if len(items) < 2:
        return None
    half = len(items) // 2
    first, second = items[:half], items[half:]
    ingredients: list[dict[str, Any]] = [
        {"id": str(i["id"]), "quantity": "1 portion", "note": ""} for i in items
    ]
    steps: list[dict[str, Any]] = [
        {
            "text": f"Prepare {_join_names([str(i['name']) for i in group])} and set them ready.",
            "minutes": 10,
            "uses": [str(i["id"]) for i in group],
        }
        for group in (first, second)
    ]
    recipe: dict[str, Any] = {
        "serves": 2,
        "prepMinutes": 10,
        "cookMinutes": 20,
        "ingredients": ingredients,
        "steps": steps,
        "tips": ["Taste as you go and adjust the seasoning at the end."],
    }
    twists = concept.get("twists") if concept is not None else None
    if isinstance(twists, dict) and twists.get("challenge"):
        recipe["cookware"] = (
            ["Large pan"]
            if twists["challenge"] == "one-pan"
            else [
                "Large pan",
                "Chopping board",
            ]
        )
    return recipe


def canned_cookout_response(caller: object, prompt: object) -> str | None:
    """The fake's answer for a Cookout run (`wixy-cookout-concepts` / `wixy-cookout-recipe`), built
    from the basket or concept the prompt carries; `None` for any other caller."""
    if not isinstance(prompt, str):
        return None
    if caller == "wixy-cookout-concepts":
        value = canned_cookout_concepts(prompt)
    elif caller == "wixy-cookout-recipe":
        value = canned_cookout_recipe(prompt)
    else:
        return None
    return json.dumps(value) if value is not None else None


@dataclass
class FakeSpawnPlan:
    """How ONE fake chat-spawn run behaves: it reports `running` for `running_polls` polls and until
    `delay_s` seconds have passed, then settles on `final_status` with `response_text`."""

    final_status: str = "completed"
    response_text: str | None = None
    running_polls: int = 0
    delay_s: float = 0.0
    error_text: str | None = None


@dataclass
class FakeSpawnRun:
    run_id: str
    session_id: str
    body: JsonObject
    plan: FakeSpawnPlan
    created_at: float = field(default_factory=time.monotonic)
    polls: int = 0
    cancelled: bool = False
    cancel_requests: int = 0

    def status(self) -> str:
        if self.cancelled:
            return "cancelled"
        if (
            self.polls <= self.plan.running_polls
            or time.monotonic() - self.created_at < self.plan.delay_s
        ):
            return "running" if self.polls > 0 else "queued"
        return self.plan.final_status


@dataclass
class FakeCmdState:
    sessions: dict[str, FakeSession] = field(default_factory=dict)
    next_session_n: int = 1
    new_chat_status_code: int = 202
    default_ready_after_polls: int = 0
    uploads: dict[str, JsonObject] = field(default_factory=dict)
    """decisions/00103: staged `POST /api/uploads` bodies, keyed by the fake's
    own issued `id` — recorded (not just accepted) so a test can assert on
    exactly what bytes/media_type a real `upload_attachment` call sent."""
    next_upload_n: int = 1
    upload_status_code: int = 201
    upload_converted_dims: tuple[int, int] = (100, 100)
    """cmd's own resize-to-1568/WEBP pipeline runs on real bytes this fake
    never actually decodes — a canned `(width, height)` a test can override
    when it cares about the specific value threaded back through
    `UploadResult`/`ChatAttachment`."""
    """Applied to every newly-created session's own `ready_after_polls` —
    unit tests default this to 0 (never auto-ready; the test sets `.ready`/
    `.ready_after_polls` explicitly per session, per scenario), while a
    fixture driving a real UI end-to-end (E2E 7) wants every session it never
    otherwise configures to become ready quickly with zero per-session
    wiring."""
    upload_bytes: dict[str, tuple[bytes, str]] = field(default_factory=dict)
    """decisions/00110: the bytes `GET /api/uploads/{id}/bytes` serves per id
    (content, media_type) — overridable per test; an id with no entry but a
    staged upload gets the canned `DEFAULT_UPLOAD_BYTES` (a real 1x1 WEBP, so
    browser `<img>` tags genuinely load in E2E)."""
    pin_apps: dict[str, FakePinApp] = field(default_factory=dict)
    """spec/server-chat/00-brief.md §5.1: the PIN-verify double's app-key
    registry — `register_pin_app` populates it; an unregistered `app_key`
    404s, mirroring cmd's real "unknown app key" answer."""

    transcribe_private_supported: bool = True
    """spec/server-chat/05-voice-transcription.md: whether this fake cmd has the private mode.
    The capability probe answers `{"private": <this>}`. When False the fake behaves like
    today's cmd — it IGNORES a `private` field and RETAINS every clip (see
    `transcribe_retained`) — so a test can prove wixy never sends audio to such a cmd."""
    transcribe_capabilities_status: int = 200
    transcribe_status_code: int = 200
    """A non-200 makes `POST /api/transcribe` fail with that status (503 + `asr_warming` when
    `transcribe_error` is set to it)."""
    transcribe_error: str | None = None
    transcribe_text: str = "hello from the fake transcriber"
    transcribe_engine: str | None = "parakeet"
    transcribe_delay_s: float = 0.0
    transcribe_gate: threading.Event | None = None
    """When set, `POST /api/transcribe` blocks until the test sets it — holds a job in flight
    so single-flight / one-at-a-time behaviour can be observed."""
    transcribe_requests: list[FakeTranscribeRequest] = field(default_factory=list)
    transcribe_probe_count: int = 0
    transcribe_in_flight: int = 0
    transcribe_max_in_flight: int = 0
    transcribe_retained: list[bytes] = field(default_factory=list)
    """The clips a RETAINING cmd would have persisted (a request without an honoured
    `private=1`) — the privacy tests assert this stays empty."""

    chat_spawn_status_code: int = 201
    """A non-201 makes `POST /api/chat-spawn/runs` refuse with that status (cmd refusing a run)."""
    chat_spawn_final_status: str = "completed"
    chat_spawn_response_text: str | None = None
    cookout_response_text: str | None = None
    """A forced final answer for the Cookout runs (`wixy-cookout-*` callers) ONLY. They never read
    `chat_spawn_response_text`, which the e2e fixture sets to an Adventure pack."""
    """The final assistant message a run settles with; `None` = `CANNED_ADVENTURE_PACK` as JSON."""
    chat_spawn_running_polls: int = 0
    chat_spawn_delay_s: float = 0.0
    chat_spawn_plans: list[FakeSpawnPlan] = field(default_factory=list)
    """Per-run plans consumed IN ORDER by successive spawns (a run with no plan left behaves per
    the four defaults above) — e.g. `[error, completed]` for the early-retry test."""
    chat_spawn_runs: dict[str, FakeSpawnRun] = field(default_factory=dict)
    chat_spawn_spawn_times: list[float] = field(default_factory=list)
    """`time.monotonic()` of every accepted spawn (the >= 5 s spacing is asserted against it)."""
    chat_spawn_in_flight_max: int = 0
    next_run_n: int = 1

    def register_pin_app(
        self, app_key: str, pin: str, *, lockout_after: int = 5, lockout_seconds: float = 60.0
    ) -> FakePinApp:
        pin_app = FakePinApp(
            app_key=app_key, pin=pin, lockout_after=lockout_after, lockout_seconds=lockout_seconds
        )
        self.pin_apps[app_key] = pin_app
        return pin_app

    def reset_pin_lockout(self, app_key: str, subject: str | None = None) -> None:
        """Clears wrong-attempt/lockout state for one app key — either one
        `subject` or every subject registered against it. The e2e fixture's own
        `/test/server/reset-pin-lockout` route (added alongside the frontend
        specs that need it) calls straight through to this."""
        pin_app = self.pin_apps.get(app_key)
        if pin_app is None:
            return
        if subject is None:
            pin_app.attempts.clear()
            pin_app.locked_until.clear()
        else:
            pin_app.attempts.pop(subject, None)
            pin_app.locked_until.pop(subject, None)

    def create_spawn_run(self, body: JsonObject) -> FakeSpawnRun:
        """Accept one `POST /api/chat-spawn/runs` body: pick its plan (the next queued one, else
        the state defaults) and record the run."""
        n = self.next_run_n
        self.next_run_n += 1
        if self.chat_spawn_plans:
            plan = self.chat_spawn_plans.pop(0)
        else:
            # Cookout runs never read `chat_spawn_response_text` (an Adventure pack in the e2e
            # fixture): they get `cookout_response_text` or the canned answer at poll time.
            is_cookout = str(body.get("caller") or "").startswith("wixy-cookout-")
            plan = FakeSpawnPlan(
                final_status=self.chat_spawn_final_status,
                response_text=None if is_cookout else self.chat_spawn_response_text,
                running_polls=self.chat_spawn_running_polls,
                delay_s=self.chat_spawn_delay_s,
            )
        run = FakeSpawnRun(
            run_id=f"run-{n:04d}", session_id=f"spawn-sess-{n}", body=body, plan=plan
        )
        self.chat_spawn_runs[run.run_id] = run
        self.chat_spawn_spawn_times.append(time.monotonic())
        return run

    def create_session(
        self,
        prompt: str,
        *,
        cmd_project: str = "",
        model: str | None = None,
        spawned_by_session_id: str | None = None,
    ) -> FakeSession:
        n = self.next_session_n
        self.next_session_n += 1
        session = FakeSession(
            session_id=f"sess-{n}",
            workspace_id=f"ws-{n}",
            prompt=prompt,
            cmd_project=cmd_project,
            model=model,
            spawned_by_session_id=spawned_by_session_id,
            ready_after_polls=self.default_ready_after_polls,
        )
        self.sessions[session.session_id] = session
        return session


class _PendingBus:
    """Fan-out for `/ws/chat-pending` transition events — tests call `publish()`
    from outside the request/response cycle (e.g. after a delay, from the test
    body) to simulate cmd reporting a provisioning failure mid-wait."""

    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue[JsonObject]] = []
        self._loop: asyncio.AbstractEventLoop | None = None

    def subscribe(self) -> asyncio.Queue[JsonObject]:
        # Captured here (not at bus-construction time) because this always runs ON
        # the server's own event loop -- the websocket route handler that calls it
        # is necessarily running there, whereas the bus itself is constructed
        # during app setup, which for `FakeCmdServer` happens on the TEST's thread
        # before the uvicorn server thread (and its loop) even exists yet.
        self._loop = asyncio.get_running_loop()
        queue: asyncio.Queue[JsonObject] = asyncio.Queue()
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[JsonObject]) -> None:
        if queue in self._subscribers:
            self._subscribers.remove(queue)

    @property
    def has_subscribers(self) -> bool:
        return bool(self._subscribers)

    def publish(self, event: JsonObject) -> None:
        """Thread-safe: `FakeCmdServer.publish_pending_event` (below) calls this
        from the TEST's own thread/loop, but the queues belong to the uvicorn
        server's background-thread loop — `call_soon_threadsafe` is the correct
        cross-loop handoff (a bare `put_nowait` here would corrupt the queue's
        internal state, since `asyncio.Queue` isn't thread-safe). A no-op if no
        websocket has connected yet (`_loop` still unset) — nothing to publish to."""
        loop = self._loop
        if loop is None:
            return
        for queue in self._subscribers:
            loop.call_soon_threadsafe(queue.put_nowait, event)


def create_fake_cmd_app(state: FakeCmdState | None = None) -> FastAPI:
    state = state if state is not None else FakeCmdState()
    pending_bus = _PendingBus()
    app = FastAPI()
    app.state.fake = state
    app.state.pending_bus = pending_bus

    @app.post("/api/pins/{app_key}/verify")
    async def pin_verify(app_key: str, request: Request) -> Response:
        """spec/server-chat/00-brief.md §5.1 v1.4's double (cmd workspace #875 PR
        #3068's real contract): `{"pin","subject"?}` -> `{"ok", "error"?,
        "attempts_left"?, "locked"?, "lock_scope"?, "retry_after_seconds"?}`, app
        key in the URL PATH. An unknown `app_key` 404s (`CmdPinVerifier` maps
        that to 503 `not_configured`); a non-JSON content-type 415s; a
        malformed-shape PIN 400s `invalid_request` (wixy validates 4-16 digits
        locally and should never actually trigger this in practice)."""
        content_type = request.headers.get("content-type", "")
        if "application/json" not in content_type:
            return Response(status_code=415)

        body = await request.json()
        pin = body.get("pin") if isinstance(body, dict) else None
        subject_raw = body.get("subject") if isinstance(body, dict) else None
        subject = subject_raw if isinstance(subject_raw, str) else ""

        if not isinstance(pin, str) or not (4 <= len(pin) <= 16) or not pin.isdigit():
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "error": "invalid_request",
                    "message": "pin must be 4-16 digits",
                },
            )
        if app_key not in state.pin_apps:
            return JSONResponse(status_code=404, content={"ok": False, "error": "unknown_app"})

        pin_app = state.pin_apps[app_key]

        if pin_app.simulate_pin_changed_once:
            pin_app.simulate_pin_changed_once = False
            return JSONResponse(status_code=409, content={"ok": False, "error": "pin_changed"})

        now = time.time()
        locked_until = pin_app.locked_until.get(subject)
        if locked_until is not None and locked_until > now:
            retry_after = max(1, int(locked_until - now))
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": str(retry_after)},
                content={
                    "ok": False,
                    "error": "locked",
                    "lock_scope": "subject",
                    "retry_after_seconds": retry_after,
                },
            )

        if pin == pin_app.pin:
            pin_app.attempts.pop(subject, None)
            pin_app.locked_until.pop(subject, None)
            return JSONResponse(status_code=200, content={"ok": True, "app_key": app_key})

        attempts = pin_app.attempts.get(subject, 0) + 1
        pin_app.attempts[subject] = attempts
        if attempts >= pin_app.lockout_after:
            locked_until = now + pin_app.lockout_seconds
            pin_app.locked_until[subject] = locked_until
            retry_after = int(pin_app.lockout_seconds)
            return JSONResponse(
                status_code=401,
                headers={"Retry-After": str(retry_after)},
                content={
                    "ok": False,
                    "error": "wrong_pin",
                    "attempts_left": 0,
                    "locked": True,
                    "lock_scope": "subject",
                    "retry_after_seconds": retry_after,
                },
            )
        return JSONResponse(
            status_code=401,
            content={
                "ok": False,
                "error": "wrong_pin",
                "attempts_left": max(0, pin_app.lockout_after - attempts),
                "locked": False,
                "lock_scope": None,
                "retry_after_seconds": 0,
            },
        )

    @app.get("/api/transcribe/capabilities")
    async def transcribe_capabilities() -> Response:
        """The probe wixy checks before ever sending audio: `{"private": true}` means cmd
        honours `private=1` (no debug save, no transcript in any log, ASR not shadowed,
        bytes in memory only)."""
        state.transcribe_probe_count += 1
        if state.transcribe_capabilities_status != 200:
            return Response(status_code=state.transcribe_capabilities_status)
        return JSONResponse({"private": state.transcribe_private_supported})

    @app.post("/api/transcribe")
    async def transcribe(request: Request) -> Response:
        """cmd's `POST /api/transcribe`: multipart `audio` + form fields, JSON
        `{raw, text, ..., engine}` back. Records exactly what arrived.

        This double does NOT itself reject a request missing `private=1`/`cleanup=0` or
        carrying `session_id`/`context` — it only RECORDS what arrived (`transcribe_requests`,
        asserted against by the tests) and tracks what a genuinely retaining cmd would have kept
        (`transcribe_retained`). That is not a live gap: `CmdTranscriber.transcribe`'s own
        signature has no parameter through which a caller could send those fields in the first
        place (spotted by the independent review, spec/server-chat/05-voice-transcription.md)."""
        form = await request.form()
        upload = form.get("audio")
        audio = b""
        filename: str | None = None
        content_type: str | None = None
        if upload is not None and not isinstance(upload, str):
            audio = await upload.read()
            filename = upload.filename
            content_type = upload.content_type
        fields = {k: v for k, v in form.items() if isinstance(v, str)}
        state.transcribe_requests.append(
            FakeTranscribeRequest(
                audio=audio, filename=filename, content_type=content_type, fields=fields
            )
        )
        if not (fields.get("private") == "1" and state.transcribe_private_supported):
            state.transcribe_retained.append(audio)
        state.transcribe_in_flight += 1
        state.transcribe_max_in_flight = max(
            state.transcribe_max_in_flight, state.transcribe_in_flight
        )
        try:
            gate = state.transcribe_gate
            while gate is not None and not gate.is_set():
                await asyncio.sleep(0.01)
            if state.transcribe_delay_s:
                await asyncio.sleep(state.transcribe_delay_s)
        finally:
            state.transcribe_in_flight -= 1
        if state.transcribe_status_code != 200:
            content: JsonObject = {"error": state.transcribe_error or "transcription failed"}
            return JSONResponse(status_code=state.transcribe_status_code, content=content)
        body: JsonObject = {
            "raw": state.transcribe_text,
            "text": state.transcribe_text,
            "tone": {},
            "ms_asr": 5,
            "ms_tone": 0,
            "ms_cleanup": 0,
            "cleaned": False,
        }
        if state.transcribe_engine is not None:
            body["engine"] = state.transcribe_engine
        return JSONResponse(body)

    def _run_row(run: FakeSpawnRun) -> JsonObject:
        """cmd's `chat_spawn_runs` row (the fields wixy reads, in cmd's names)."""
        status = run.status()
        row: JsonObject = {
            "run_id": run.run_id,
            "session_id": run.session_id,
            "caller": run.body.get("caller"),
            "model": run.body.get("model"),
            "status": status,
            "bucket": run.body.get("bucket"),
            "response_text": None,
            "error_text": None,
        }
        if status == "completed":
            text = run.plan.response_text
            caller = str(run.body.get("caller") or "")
            if text is None and caller.startswith("wixy-cookout-"):
                text = state.cookout_response_text
                if text is None:
                    text = canned_cookout_response(caller, run.body.get("prompt"))
            elif text is None:
                text = state.chat_spawn_response_text
            row["response_text"] = text if text is not None else json.dumps(CANNED_ADVENTURE_PACK)
        elif status in ("error", "timeout"):
            row["error_text"] = run.plan.error_text or "process exited before end_turn"
        return row

    @app.post("/api/chat-spawn/runs")
    async def chat_spawn_create(request: Request) -> Response:
        """cmd's headless one-shot chat run: validate the body like cmd (a missing required field
        is a 400, `spawned_by_session_id` must be present — `""` is the deliberate unparented
        sentinel), record exactly what arrived, answer 201 with the row NESTED under `run`."""
        if state.chat_spawn_status_code != 201:
            return JSONResponse(
                status_code=state.chat_spawn_status_code, content={"detail": "refused"}
            )
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse(status_code=400, content={"detail": "body must be an object"})
        missing = [k for k in ("caller", "prompt", "model", "cwd") if not body.get(k)]
        if missing:
            return JSONResponse(
                status_code=400,
                content={"detail": f"missing required field(s): {', '.join(missing)}"},
            )
        if body.get("spawned_by_session_id") is None:
            return JSONResponse(
                status_code=400, content={"detail": "spawned_by_session_id is required"}
            )
        run = state.create_spawn_run(body)
        in_flight = sum(
            1 for r in state.chat_spawn_runs.values() if r.status() in ("queued", "running")
        )
        state.chat_spawn_in_flight_max = max(state.chat_spawn_in_flight_max, in_flight)
        return JSONResponse(status_code=201, content={"run": _run_row(run)})

    @app.get("/api/chat-spawn/runs/{run_id}")
    async def chat_spawn_get(run_id: str) -> Response:
        run = state.chat_spawn_runs.get(run_id)
        if run is None:
            return JSONResponse(status_code=404, content={"detail": "unknown run"})
        run.polls += 1
        return JSONResponse({"run": _run_row(run)})

    @app.post("/api/chat-spawn/runs/{run_id}/cancel")
    async def chat_spawn_cancel(run_id: str) -> Response:
        run = state.chat_spawn_runs.get(run_id)
        if run is None:
            return JSONResponse(status_code=404, content={"detail": "unknown run"})
        run.cancel_requests += 1
        if run.status() in ("queued", "running"):
            run.cancelled = True
        return JSONResponse({"run": _run_row(run)})

    @app.post("/api/project/{project}/new-chat")
    async def new_chat(project: str, request: Request) -> Response:
        if state.new_chat_status_code != 202:
            return Response(status_code=state.new_chat_status_code)
        body = await request.json()
        prompt = body.get("prompt", "") if isinstance(body, dict) else ""
        # cmd REQUIRES `spawned_by_session_id` (its engine/spawn_lineage.py,
        # `required=True` since cmd decisions/00071): omitted or null is a 400,
        # not a default. This fake enforces it because NOT enforcing it is
        # precisely how the real bug shipped — the create call sent `{"prompt"}`
        # alone, cmd 400'd, `routes_chat` turned that into the 502 the owner saw
        # on "Start", and the whole suite stayed green against a fake that
        # accepted anything. A test double that is laxer than the real service
        # cannot catch contract drift, so this one mirrors the contract.
        spawned_by_raw = body.get("spawned_by_session_id") if isinstance(body, dict) else None
        if spawned_by_raw is None:
            return JSONResponse(
                status_code=400,
                content={"error": "spawned_by_session_id is required"},
            )
        model_raw = body.get("model") if isinstance(body, dict) else None
        attachments_raw = body.get("attachments") if isinstance(body, dict) else None
        # cmd's `_stage_new_chat_attachments` 404s an unknown `upload_id` —
        # mirrored here for the same reason the `spawned_by_session_id` 400
        # above is: a double laxer than the real service cannot catch drift.
        if isinstance(attachments_raw, list):
            for idx, entry in enumerate(attachments_raw):
                upload_id = entry.get("upload_id") if isinstance(entry, dict) else None
                if not isinstance(upload_id, str) or upload_id not in state.uploads:
                    return JSONResponse(
                        status_code=404,
                        content={
                            "error": f"unknown upload_id {upload_id!r}",
                            "rejected_index": idx,
                        },
                    )
        session = state.create_session(
            prompt,
            cmd_project=project,
            model=model_raw if isinstance(model_raw, str) else None,
            spawned_by_session_id=spawned_by_raw if isinstance(spawned_by_raw, str) else None,
        )
        if isinstance(attachments_raw, list):
            session.create_attachments = [a for a in attachments_raw if isinstance(a, dict)]
        return JSONResponse(
            status_code=202,
            content={
                "session_id": session.session_id,
                "pending_state": "queued",
                "workspace_id": session.workspace_id,
            },
        )

    @app.get("/api/session/{session_id}")
    async def get_session(session_id: str) -> Response:
        session = state.sessions.get(session_id)
        if session is None:
            return Response(status_code=404)
        session.poll_count += 1
        if not session.ready and session.poll_count >= session.ready_after_polls > 0:
            session.ready = True
        if not session.ready:
            return Response(status_code=404)
        return JSONResponse({"session_id": session_id})

    @app.get("/api/session/{session_id}/chain")
    async def get_chain(session_id: str) -> Response:
        session = state.sessions.get(session_id)
        if session is None:
            return Response(status_code=404)
        chain = session.chain if session.chain else [session_id]
        return JSONResponse({"chain": chain})

    @app.post("/api/session/{session_id}/send")
    async def send(session_id: str, request: Request) -> Response:
        session = state.sessions.get(session_id)
        if session is None:
            return Response(status_code=404)
        if session.send_status_code != 202:
            return Response(status_code=session.send_status_code)
        body = await request.json()
        session.last_send_body = body if isinstance(body, dict) else None
        # cmd's `_resolve_upload_ids_to_blocks` 404s an unknown `upload_id`,
        # same contract as the new-chat staging above.
        attachments_raw = body.get("attachments") if isinstance(body, dict) else None
        if isinstance(attachments_raw, list):
            for idx, entry in enumerate(attachments_raw):
                upload_id = entry.get("upload_id") if isinstance(entry, dict) else None
                if not isinstance(upload_id, str) or upload_id not in state.uploads:
                    return JSONResponse(
                        status_code=404,
                        content={
                            "error": f"unknown upload_id {upload_id!r}",
                            "rejected_index": idx,
                        },
                    )
        idem_key = body.get("idempotency_key") if isinstance(body, dict) else None
        if isinstance(idem_key, str):
            session.idempotency_seen[idem_key] = session.idempotency_seen.get(idem_key, 0) + 1
        return JSONResponse(
            status_code=202, content={"accepted": True, "buffered": session.send_buffered}
        )

    @app.post("/api/uploads")
    async def uploads(request: Request) -> Response:
        if state.upload_status_code != 201:
            return Response(status_code=state.upload_status_code)
        body = await request.json()
        n = state.next_upload_n
        state.next_upload_n += 1
        upload_id = f"upload-{n}"
        state.uploads[upload_id] = body if isinstance(body, dict) else {}
        width, height = state.upload_converted_dims
        media_type = body.get("media_type") if isinstance(body, dict) else None
        return JSONResponse(
            status_code=201,
            content={
                "id": upload_id,
                "kind": body.get("kind") if isinstance(body, dict) else None,
                "original": {"size": 0, "media_type": media_type},
                "converted": {
                    "size": 0,
                    "media_type": "image/webp",
                    "width": width,
                    "height": height,
                },
                "processing_ms": 1,
            },
        )

    @app.get("/api/uploads/{upload_id}/bytes")
    async def upload_bytes_route(upload_id: str) -> Response:
        """decisions/00110: mirrors cmd's own inline-bytes endpoint (the one
        cmd's chat UI uses for previews and wixy's proxy route forwards). 404
        for an id the fake never staged, exactly as cmd's row-lookup does."""
        if upload_id not in state.uploads:
            return Response(status_code=404)
        content, media_type = state.upload_bytes.get(
            upload_id, (DEFAULT_UPLOAD_BYTES, "image/webp")
        )
        return Response(content=content, media_type=media_type)

    @app.get("/sessions/{session_id}/messages")
    async def get_messages(
        session_id: str,
        limit: int = 80,
        before: int | None = None,
        include_tools: bool = True,
        include_thinking: bool = False,
    ) -> Response:
        session = state.sessions.get(session_id)
        if session is None:
            return Response(status_code=404)
        messages = session.messages
        if not include_thinking:
            # Mirrors spec/06 §1: cmd never includes kind:"thinking" entries
            # unless explicitly asked — the wixy stream's own "show reasoning"
            # toggle relies on this filtering actually happening somewhere.
            messages = [m for m in messages if m.get("kind") != "thinking"]
        if before is not None:
            messages = [
                m for m in messages if isinstance((idx := m.get("index")), int) and idx < before
            ]
        return JSONResponse({"messages": messages[-limit:]})

    @app.get("/sessions/{session_id}/status")
    async def get_status(session_id: str) -> Response:
        session = state.sessions.get(session_id)
        if session is None:
            return Response(status_code=404)
        return JSONResponse(session.status)

    @app.websocket("/ws/chat-pending")
    async def ws_chat_pending(websocket: WebSocket) -> None:
        await websocket.accept()
        queue = pending_bus.subscribe()
        try:
            await websocket.send_json({"type": "hello", "pending": list(state.sessions.keys())})
            while True:
                event = await queue.get()
                await websocket.send_json(event)
        except WebSocketDisconnect:
            pass
        finally:
            pending_bus.unsubscribe(queue)

    return app


class FakeCmdServer:
    """A real uvicorn instance on an ephemeral localhost port, for tests that need
    a genuine socket (the `/ws/chat-pending` websocket — `httpx.ASGITransport`
    can't do the upgrade). Runs the server loop on a background thread, mirroring
    `test_kill_during_publish.py`'s precedent of using a real process/thread for
    what a mocked transport genuinely can't exercise."""

    def __init__(self, state: FakeCmdState | None = None) -> None:
        self.state = state if state is not None else FakeCmdState()
        self._app = create_fake_cmd_app(self.state)
        config = uvicorn.Config(self._app, host="127.0.0.1", port=0, log_level="warning")
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, daemon=True)

    def start(self, *, timeout_s: float = 10.0) -> int:
        self._thread.start()
        deadline = time.monotonic() + timeout_s
        while not self._server.started:
            if time.monotonic() > deadline:
                raise TimeoutError("fake cmd server did not start in time")
            time.sleep(0.01)
        server_socket = self._server.servers[0].sockets[0]
        port: int = server_socket.getsockname()[1]
        return port

    def wait_for_pending_subscriber(self, *, timeout_s: float = 5.0) -> None:
        """Blocks until a `/ws/chat-pending` client has connected — call this
        before `publish_pending_event` to avoid the race where the event is
        published before `cmdchat.CmdChatClient.watch_pending`'s connection has
        actually been accepted (a publish with no subscriber yet is silently
        dropped, matching a real pub/sub's semantics, not queued for later)."""
        bus: _PendingBus = self._app.state.pending_bus
        deadline = time.monotonic() + timeout_s
        while not bus.has_subscribers:
            if time.monotonic() > deadline:
                raise TimeoutError("no /ws/chat-pending subscriber connected in time")
            time.sleep(0.01)

    def publish_pending_event(self, event: JsonObject) -> None:
        bus: _PendingBus = self._app.state.pending_bus
        bus.publish(event)

    def stop(self, *, timeout_s: float = 10.0) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=timeout_s)
