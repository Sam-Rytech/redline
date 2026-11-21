import type { Watch } from "@redline/api-types";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api, ApiFailure } from "../../lib/api";
import { Button } from "../../ui/Button";
import s from "./Loans.module.css";

/** Optimistic: the button flips at once, and rolls back with a reason if the server says no. */
export function WatchToggle({ loanId }: { loanId: string }) {
  const [watchId, setWatchId] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const navigate = useNavigate();

  const toggle = async () => {
    setMsg(null);
    if (!watching) {
      setWatching(true);
      try {
        const w = await api<Watch>("/watches", { method: "POST", json: { loanId } });
        setWatchId(w.id);
      } catch (e) {
        setWatching(false);
        if (e instanceof ApiFailure && e.status === 401) return navigate("/sign-in");
        if (e instanceof ApiFailure && e.body?.error.code === "watch_limit") return setMsg("Free watches one loan. The Pro pass watches all of them.");
        if (e instanceof ApiFailure && e.body?.error.code === "watch_exists") return setWatching(true);
        setMsg("Could not save the watch. Check your connection and try again.");
      }
    } else {
      setWatching(false);
      try {
        if (watchId) await api(`/watches/${watchId}`, { method: "DELETE" });
      } catch {
        setWatching(true);
        setMsg("Could not remove the watch. Try again.");
      }
    }
  };

  return (
    <div className={s.watch}>
      <Button variant={watching ? "quiet" : "primary"} onClick={toggle} aria-pressed={watching}>
        {watching ? "Watching" : "Watch this loan"}
      </Button>
      {msg && <p className={s.watchMsg} role="alert">{msg}</p>}
    </div>
  );
}
