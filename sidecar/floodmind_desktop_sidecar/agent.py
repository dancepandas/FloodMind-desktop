"""Agent seam. The sidecar talks to any Agent implementing this protocol;
Plan 2 wires the real FloodMind SDK behind it (see floodmind_agent.py)."""
from __future__ import annotations

from typing import Iterator, Protocol, TypedDict


class Message(TypedDict):
    role: str
    content: str


class Agent(Protocol):
    def stream(self, messages: list[Message]) -> Iterator[dict]:
        """Yield event dicts, e.g. {"type": "text", "content": "..."} and {"type": "done"}."""
        ...

    def clear_memory(self) -> None:
        """Forget conversation history (New Session). No-op when the agent has no memory."""
        ...

    def rebind_workspace(self, path: str) -> None:
        """Re-bind the agent's memory/session to a workspace folder (per-workspace isolation)."""
        ...


class StubAgent:
    """Deterministic stub used until the real FloodMind agent is wired in."""

    def stream(self, messages: list[Message]) -> Iterator[dict]:
        user_text = messages[-1]["content"] if messages else ""
        reply = f"[sidecar stub] 收到：{user_text}"
        mid = len(reply) // 2
        chunks = [reply[:mid], reply[mid:]]
        for c in chunks:
            yield {"type": "text", "content": c}
        yield {"type": "done"}

    def clear_memory(self) -> None:
        pass

    def rebind_workspace(self, path: str) -> None:
        pass
