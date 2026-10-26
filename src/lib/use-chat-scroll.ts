import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** A little tolerance for fractional pixels and an intentional near-bottom read. */
const BOTTOM_THRESHOLD = 64;

/**
 * Follow new content only while the reader is at the bottom. Conversation changes
 * start at the latest message; token updates never reset the reader's intent.
 */
export function useChatScroll(conversationId: string | null, contentVersion: unknown, enabled = true) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const jumpToLatest = useCallback(() => {
    followingRef.current = true;
    setShowJumpToLatest(false);
    const viewport = scrollRef.current;
    // An immediate local scroll avoids accumulated smooth animations during
    // streaming, respects reduced motion, and never scrolls an outer panel.
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    followingRef.current = true;
    setShowJumpToLatest(false);
    if (!enabled) return;
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const isNearBottom = () =>
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= BOTTOM_THRESHOLD;
    const onScroll = () => {
      followingRef.current = isNearBottom();
      setShowJumpToLatest(!followingRef.current);
    };
    const onResize = () => {
      if (followingRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
      } else {
        // Shrinking/collapsing content can remove the gap without a scroll event.
        followingRef.current = isNearBottom();
        setShowJumpToLatest(!followingRef.current);
      }
    };

    viewport.addEventListener("scroll", onScroll, { passive: true });
    jumpToLatest();
    // Content observation catches image loads, disclosure animations and other
    // layout changes that don't change the turns array. Viewport observation
    // also follows when the composer or window changes the available height.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    observer?.observe(content);
    observer?.observe(viewport);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [conversationId, enabled, jumpToLatest]);

  useLayoutEffect(() => {
    if (enabled && followingRef.current) jumpToLatest();
  }, [conversationId, contentVersion, enabled, jumpToLatest]);

  return { scrollRef, contentRef, showJumpToLatest, jumpToLatest };
}
