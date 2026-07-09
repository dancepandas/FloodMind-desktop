"""Adapter wrapping the real FloodMind SDK Agent behind our sidecar Agent seam.

Plan 2 swaps the Plan 1 StubAgent for this. The SDK's raw stream events are
translated into the sidecar's flat NDJSON schema (see Plan 2 doc).
"""
from __future__ import annotations

from typing import Iterator

from .agent import Message


def translate_event(raw: dict) -> list[dict]:
    """Map one raw SDK event to zero-or-more sidecar-schema events.

    Pure function — no network, no SDK import — so it is unit-testable in
    isolation. Unknown event types pass through with their type preserved so
    new SDK events are visible rather than silently dropped.
    """
    t = raw.get("type")

    if t == "answer_delta":
        return [{"type": "text", "content": raw.get("content", "")}]
    if t == "thought_delta":
        return [{"type": "thinking", "content": raw.get("content", "")}]
    if t == "action_start":
        return [{"type": "tool_start", "call_id": raw.get("call_id", ""),
                 "tool_name": raw.get("tool_name", ""), "input": raw.get("tool_input", "")}]
    if t == "action_end":
        return [{"type": "tool_end", "call_id": raw.get("call_id", ""),
                 "tool_name": raw.get("tool_name", ""),
                 "status": raw.get("status", ""), "output": raw.get("content", "")}]
    if t == "workflow_plan":
        return [{"type": "plan", "title": raw.get("title", ""),
                 "steps": raw.get("steps", [])}]
    if t == "workflow_step":
        return [{"type": "step", "key": raw.get("step_key", raw.get("key", "")),
                 "status": raw.get("status", ""), "title": raw.get("title", ""),
                 "outcome": raw.get("outcome", "")}]
    if t in ("file_generated", "image_generated"):
        return [{"type": "artifact",
                 "kind": "image" if t == "image_generated" else "file",
                 "name": raw.get("filename", raw.get("file_name", "")),
                 "path": raw.get("image_url", raw.get("download_url", ""))}]
    if t == "permission_ask":
        return [{"type": "permission", "ask_id": raw.get("ask_id", ""),
                 "call_id": raw.get("call_id", ""), "tool_name": raw.get("tool_name", ""),
                 "reason": raw.get("reason", ""), "input": raw.get("tool_input", {})}]
    if t == "token_usage":
        return [{"type": "usage", "prompt": raw.get("prompt_tokens", 0),
                 "completion": raw.get("completion_tokens", 0),
                 "total": raw.get("total_tokens", 0)}]
    if t == "error":
        return [{"type": "error", "content": raw.get("content", "")}]

    # Noisy or redundant events we intentionally drop.
    if t in ("heartbeat", "final_text", "llm_step_start", "llm_step_end",
             "context_compress_start", "context_compress_done", "permission_resolved",
             "retry_attempt", "system", "attachment_context", "memory_status"):
        return []

    # Unknown event: minimal pass-through (drop nothing except the type key dup).
    return [{"type": t or "unknown", **{k: v for k, v in raw.items() if k != "type"}}]


class FloodMindAgent:
    """Sidecar Agent backed by the real FloodMind SDK.

    Implements the sidecar `Agent` protocol (a `.stream(messages) -> Iterator[dict]`
    method). Constructs the SDK `Agent` lazily so importing this module does not
    pay the SDK's heavy init cost or require a configured LLM at import time.
    """

    def __init__(self, permission_handler=None):
        # Imported lazily so translate_event stays unit-testable without the SDK.
        from floodmind.agent import Agent
        from floodmind.agent.native.model_client import ModelClient

        llm = ModelClient.from_settings()
        # Auto-approve by default; Task 5 replaces this with a UI-driven handler.
        self._permission_handler = permission_handler or (lambda tool_name, tool_input: True)
        self._agent = Agent(
            llm=llm,
            permission_handler=self._permission_handler,
            max_iterations=50,
        )

    def stream(self, messages: list[Message]) -> Iterator[dict]:
        user_text = messages[-1]["content"] if messages else ""
        for raw in self._agent.stream(user_text):
            for ev in translate_event(raw):
                yield ev
        yield {"type": "done"}
