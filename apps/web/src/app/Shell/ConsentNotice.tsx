import { useState } from "react";
import { Link } from "react-router";
import { Button } from "../../ui/Button";
import s from "./Shell.module.css";

const KEY = "rl_cookie_notice";

function dismissed() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Redline sets only strictly necessary cookies and runs no analytics, so this is a notice, not a choice. */
export function ConsentNotice() {
  const [open, setOpen] = useState(() => !dismissed());
  if (!open) return null;
  const close = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* storage blocked: the notice shows again next visit */
    }
    setOpen(false);
  };
  return (
    <div className={s.consent} role="region" aria-label="Cookie notice">
      <p>
        We use one cookie to keep you signed in. No tracking, no analytics. <Link to="/legal/cookies">Cookie policy</Link>
      </p>
      <Button variant="secondary" onClick={close}>Got it</Button>
    </div>
  );
}
