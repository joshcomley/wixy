"""Error types shared across the builder.

`BuildError` is raised by the `build`/`render` pipeline (fatal — the caller must stop).
`ValidationError` entries are collected by `validate()` into a machine-readable list
(02 §10) rather than raised, so the admin UI/CI/AI agent can surface every problem at
once instead of one-at-a-time.
"""

from __future__ import annotations

from dataclasses import dataclass, field


class BuildError(Exception):
    """Raised when the build/render pipeline cannot produce output.

    `location` is a `file:key`-shaped string (e.g. ``content/index.json:hero.title``)
    pinpointing the failure, per spec/02-content-model.md §10's "precise file:key error"
    requirement.
    """

    def __init__(self, message: str, *, location: str | None = None) -> None:
        self.location = location
        full = f"{location}: {message}" if location else message
        super().__init__(full)


@dataclass(frozen=True, slots=True)
class ValidationError:
    """One machine-readable validation failure (spec/02-content-model.md §10)."""

    code: str
    message: str
    file: str | None = None
    key: str | None = None

    def to_dict(self) -> dict[str, str]:
        out: dict[str, str] = {"code": self.code, "message": self.message}
        if self.file is not None:
            out["file"] = self.file
        if self.key is not None:
            out["key"] = self.key
        return out


@dataclass(slots=True)
class ValidationResult:
    """Aggregate result of `validate()` — the admin UI/CI/AI agent consume `errors`."""

    errors: list[ValidationError] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def add(
        self, code: str, message: str, *, file: str | None = None, key: str | None = None
    ) -> None:
        self.errors.append(ValidationError(code=code, message=message, file=file, key=key))

    def to_json_dict(self) -> dict[str, object]:
        return {"ok": self.ok, "errors": [e.to_dict() for e in self.errors]}
