"""Replay the SDK text recording through Python and compare durable accounting facts."""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps/cli/lib/bin.js"
SCENARIO = ROOT / "snapshots/sdk/text-turn"
NODE = shutil.which("node")


@pytest.mark.skipif(not CLI.exists() or NODE is None, reason="requires the built dsh profile runtime and Node")
def test_recorded_request_accounting_snapshot(tmp_path_factory: pytest.TempPathFactory) -> None:
    assert NODE is not None
    tmp_path = tmp_path_factory.mktemp("a")
    fixture = max(SCENARIO.glob("session.v*.jsonl"), key=lambda path: int(path.stem.rsplit(".v", 1)[1]))
    rows = [json.loads(line) for line in fixture.read_text(encoding="utf-8").splitlines()]
    task = next(row["data"] for row in rows if row["type"] == "user/message" and row["data"]["source"]["kind"] == "user")
    replay = tmp_path / fixture.name
    replay.write_text(fixture.read_text(encoding="utf-8").replace("{{cwd}}", str(tmp_path).replace("\\", "\\\\")), encoding="utf-8")
    home = tmp_path / "home"
    replay_patch = tmp_path / "cordis.snapshot.yml"
    replay_patch.write_text((SCENARIO / "cordis.snapshot.yml").read_text(encoding="utf-8").replace(
        "@deepseek-ai/dsh-llm-replay", (ROOT / "packages/test-support/llm-replay/lib/index.js").as_uri()), encoding="utf-8")
    patches = (SCENARIO / "cordis.yml", replay_patch)
    # The documented internal test adapter launches the real CLI, not another app entrypoint.
    launch = (NODE, str(CLI), "--profile", "sdk", *(arg for patch in patches for arg in ("--patch", str(patch))))
    with DeepSeekHarness(
        provider="deepseek-official", model="deepseek-v4-flash", cwd=str(tmp_path),
        _launch_args=launch,
        env={"DSH_HOME": str(home), "DSH_TELEMETRY_DISABLED": "1", "DSH_SNAPSHOT": "replay",
             "DSH_SNAPSHOT_FILE": str(replay), "DSH_SNAPSHOT_FEEDBACK": "1", "DEEPSEEK_API_KEY": ""},
        request_timeout_seconds=30,
    ) as harness:
        result = harness.run(task["content"], session_id="a")
        diagnostics = "\n".join(harness._client._stderr_lines)
    assert result.final_response == "SDK snapshot OK", diagnostics + "\n" + json.dumps(result.events[-3:])
    ending = next(event for event in reversed(result.events) if event["type"] == "turn/end")
    assert ending["data"]["reason"]["kind"] == "completed", ending
    assistant = next(event for event in result.events if event["type"] == "assistant/message")
    request = assistant["data"]["request"]
    header = next(event for event in result.events if event["seq"] == request["headerSeq"])
    context = next(event for event in result.events if event["seq"] == request["contextSeq"])
    assert header["type"] == "request/header"
    assert context["type"] == "request/context"
    assert request["logOffset"] == context["seq"] + 1
    assert request["logOffset"] <= assistant["seq"]
    assert isinstance(context["data"]["toolProjection"]["tokens"], int)
    assert context["data"]["toolProjection"]["tokens"] > 0
    subscribed = [notification.payload["event"] for notification in result.notifications
                  if notification.method == "session.event" and notification.payload.get("sessionId") == result.session_id]
    assert next(event for event in subscribed if event["seq"] == assistant["seq"])["data"] == assistant["data"]
    assert next(event for event in subscribed if event["seq"] == context["seq"])["data"] == context["data"]
    logs = list((home / "sessions").rglob("session.v*.jsonl"))
    assert len(logs) == 1
    persisted = [json.loads(line) for line in logs[0].read_text(encoding="utf-8").splitlines()]
    assert next(event for index, event in enumerate(persisted[1:]) if index == assistant["seq"])["data"] == assistant["data"]
    assert next(event for index, event in enumerate(persisted[1:]) if index == context["seq"])["data"] == context["data"]
    actual = {
        "final_response": result.final_response,
        "finish_reason": result.finish_reason,
        "request": {"version": request["version"], "header_type": header["type"], "context_type": context["type"],
                    "cut_after_context": request["logOffset"] == context["seq"] + 1},
        "context": {"provider": context["data"]["provider"], "model": context["data"]["model"],
                    "capacity_known": "contextWindow" in context["data"], "reserve_known": "outputReserve" in context["data"],
                    "tool_mode": context["data"]["toolProjection"]["mode"]},
        "feedback": [event["type"] for event in result.events if event["type"].startswith("feedback/")],
    }
    assert actual["feedback"] == [row["type"] for row in rows if row["type"].startswith("feedback/")]
    expected = Path(__file__).with_name("expected") / "accounting-session.json"
    if os.environ.get("DSH_SNAPSHOT") == "refresh":
        expected.write_text(json.dumps(actual, indent=2) + "\n", encoding="utf-8")
    assert actual == json.loads(expected.read_text(encoding="utf-8"))
