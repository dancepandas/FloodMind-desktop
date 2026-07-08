"""Agent seam. Plan 2 replaces StubAgent with the real FloodMind SDK."""
from __future__ import annotations

from typing import Iterator, Protocol, TypedDict


class Message(TypedDict):
    role: str
    content: str


class Agent(Protocol):
    def stream(self, messages: list[Message]) -> Iterator[dict]:
        """Yield event dicts, e.g. {"type": "text", "content": "..."} and {"type": "done"}."""
        ...


class StubAgent:
    """Deterministic stub used until the real FloodMind agent is wired in."""

    def stream(self, messages: list[Message]) -> Iterator[dict]:
        user_text = messages[-1]["content"] if messages else ""
        reply = f"[sidecar stub] 收到：{user_text}"
        mid = len(reply) // 2
        chunks = [reply[:mid], reply[mid:], ""]
        for c in chunks:
            yield {"type": "text", "content": c}
        yield {"type": "done"}
