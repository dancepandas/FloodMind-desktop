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

    def append_instruction(self, text: str) -> None:
        """Append a user instruction to the agent's memory mid-run.

        The SDK's executor polls memory between iterations and injects any new
        user message into the active run (steering) or revives at terminal state
        (queued follow-up). No-op when the agent has no memory.
        """
        ...

    def pause(self) -> None:
        """Signal the running stream to abort at the next LLM/tool boundary.

        The partial round is discarded (not written to memory); the next
        stream() resumes from memory.
        """
        ...

    def clear_memory(self) -> None:
        """Forget conversation history (New Session). No-op when the agent has no memory."""
        ...

    def rebind_workspace(self, path: str) -> None:
        """Re-bind the agent's memory/session to a workspace folder (per-workspace isolation)."""
        ...

    def reload_model(self) -> bool:
        """Re-read model settings + rebuild the agent so config changes take effect.

        Returns True if the agent was rebuilt, False on failure (config is still
        saved; a restart will apply it).
        """
        ...

    def reload_persona(self) -> bool:
        """Rebuild the agent so SOUL.md / AGENTS.md edits take effect now.

        Returns True if rebuilt, False on failure (files are still saved; a
        restart will apply them).
        """
        ...

    def activate_conversation(self, session_id: str) -> None:
        """Rebuild the agent bound to this conversation's session_id (memory isolation)."""
        ...

    def generate_title(self, message: str) -> str:
        """Return a short LLM-generated title for the conversation, or '' on failure."""
        ...

    def set_permission_mode(self, mode: str) -> None:
        """Set the global tool permission mode (always-trust|trust-once|always-ask)."""
        ...

    def respond_to_permission_ask(self, ask_id: str, approved: bool) -> dict:
        """Respond to a pending permission ask. Returns {"ok": True} or {"error": ...}."""
        ...

    def run_headless(self, session_id: str, workspace_path: str, command: str):
        """Run `command` in an isolated background session bound to `session_id`,
        with `workspace_path` set in the calling thread's contextvars. Returns
        (events, artifacts, final_text). Does NOT touch the foreground agent."""
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

    def append_instruction(self, text: str) -> None:
        pass

    def pause(self) -> None:
        pass

    def rebind_workspace(self, path: str) -> None:
        pass

    def reload_model(self) -> bool:
        return True

    def reload_persona(self) -> bool:
        return True

    def activate_conversation(self, session_id: str) -> None:
        pass

    def generate_title(self, message: str) -> str:
        return ""

    def set_permission_mode(self, mode: str) -> None:
        pass

    def respond_to_permission_ask(self, ask_id: str, approved: bool) -> dict:
        return {"ok": True}

    def run_headless(self, session_id, workspace_path, command):
        return [], [], ""
