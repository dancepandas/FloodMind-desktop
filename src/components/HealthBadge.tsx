import { useEffect, useState } from "react";
import { checkHealth, getBaseUrl } from "../lib/sidecar-client";

type Status = "checking" | "up" | "down";

export default function HealthBadge() {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const baseUrl = await getBaseUrl();
        const ok = await checkHealth(baseUrl);
        if (!cancelled) setStatus(ok ? "up" : "down");
      } catch {
        if (!cancelled) setStatus("down");
      }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const label = { checking: "connecting", up: "online", down: "offline" }[status];
  return (
    <span className="pill">
      <span className={`sdot sdot-${status}`} />
      {label}
    </span>
  );
}
