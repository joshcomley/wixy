from __future__ import annotations

import anyio
import pytest

from wixy_server.background import BackgroundTaskHealth, ContainedTaskGroup


@pytest.mark.asyncio
async def test_supervised_failure_restarts_without_cancelling_sibling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_sleep = anyio.sleep
    monkeypatch.setattr(anyio, "sleep", lambda _delay: real_sleep(0))
    health = BackgroundTaskHealth()
    watcher_ran = anyio.Event()
    loop_restarted = anyio.Event()
    attempts = 0

    async def chat_loop() -> None:
        nonlocal attempts
        attempts += 1
        if attempts <= 3:
            raise RuntimeError("simulated tick failure")
        loop_restarted.set()
        await anyio.sleep_forever()

    async def watcher() -> None:
        watcher_ran.set()
        await anyio.sleep_forever()

    async with anyio.create_task_group() as task_group:
        contained = ContainedTaskGroup(task_group, health)
        contained.supervise("livechat-erasure", chat_loop)
        task_group.start_soon(watcher)
        with anyio.fail_after(2):
            await watcher_ran.wait()
            await loop_restarted.wait()
        assert health.consecutive_failures("livechat-erasure") == 3
        assert health.last_failure_at("livechat-erasure") is not None
        assert health.media_degraded()
        assert not hasattr(contained, "start_soon")
        task_group.cancel_scope.cancel()


@pytest.mark.asyncio
async def test_one_shot_failure_does_not_cancel_later_work() -> None:
    health = BackgroundTaskHealth()
    later_ran = anyio.Event()

    async def fail() -> None:
        raise RuntimeError("simulated one-shot failure")

    async def later() -> None:
        later_ran.set()

    async with anyio.create_task_group() as task_group:
        contained = ContainedTaskGroup(task_group, health)
        contained.spawn("push-dispatch", fail)
        contained.spawn("push-dispatch", later)
        with anyio.fail_after(1):
            await later_ran.wait()
        await anyio.sleep(0)
        assert health.consecutive_failures("push-dispatch") == 1
        task_group.cancel_scope.cancel()
