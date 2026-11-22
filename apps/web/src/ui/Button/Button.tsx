import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";
import s from "./Button.module.css";

type Variant = "primary" | "secondary" | "quiet";
type State = "idle" | "working" | "done";
type Common = {
  variant?: Variant;
  /** The cap shows an arrow, a spinner while working, a tick when done. */
  state?: State;
  /** Gentle idle nudge of the arrow. One per screen. */
  beckon?: boolean;
  children: ReactNode;
  className?: string;
};

// Phosphor bold paths, inlined.
const ARROW = "M224.49,136.49l-72,72a12,12,0,0,1-17-17L187,140H40a12,12,0,0,1,0-24H187L135.51,64.48a12,12,0,0,1,17-17l72,72A12,12,0,0,1,224.49,136.49Z";
const CHECK = "M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z";
const NOTCH = "M236,128a108,108,0,0,1-216,0c0-42.52,24.73-81.34,63-98.9A12,12,0,1,1,93,50.91C63.24,64.57,44,94.83,44,128a84,84,0,0,0,168,0c0-33.17-19.24-63.43-49-77.09A12,12,0,1,1,173,29.1C211.27,46.66,236,85.48,236,128Z";

function Cap({ state }: { state: State }) {
  const d = state === "working" ? NOTCH : state === "done" ? CHECK : ARROW;
  return (
    <span className={s.cap} aria-hidden="true">
      <svg viewBox="0 0 256 256" width="15" height="15" className={state === "working" ? s.spin : undefined}>
        <path fill="currentColor" d={d} />
      </svg>
    </span>
  );
}

const cls = (v: Variant, beckon: boolean, state: State, extra: string) =>
  `${s.pill} ${s[v]} ${beckon && state === "idle" ? s.beckon : ""} ${extra}`;

export function Button({
  variant = "primary",
  state = "idle",
  beckon = false,
  className = "",
  children,
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cls(variant, beckon, state, className)} data-state={state} aria-busy={state === "working" || undefined} {...rest}>
      <span className={s.label}>{children}</span>
      <Cap state={state} />
    </button>
  );
}

export function ButtonLink({ to, variant = "primary", state = "idle", beckon = false, className = "", children }: Common & { to: string }) {
  return (
    <Link to={to} className={cls(variant, beckon, state, className)} data-state={state}>
      <span className={s.label}>{children}</span>
      <Cap state={state} />
    </Link>
  );
}
