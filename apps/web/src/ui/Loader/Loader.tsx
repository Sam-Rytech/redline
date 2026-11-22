import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { RIBBON_D, RIBBON_START, RIBBON_VIEWBOX, RIBBON_WIDTH } from "../Logo";
import s from "./Loader.module.css";

const LINE = 0.55;
const MARK = 1.1;
const HOLD = 0.4;
const LIFT = 0.75;
const LOADED_AT = performance.now();

/** Seconds until the preloader has mostly lifted off the first screen; 0 once it has gone or with reduced motion. */
export function introDelay(): number {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  const left = LINE + MARK + HOLD + LIFT * 0.55 - (performance.now() - LOADED_AT) / 1000;
  return Math.max(0, left);
}

/**
 * Preloader on every full page load: a red line draws from the left edge at mid-height,
 * runs into the mark and writes the whole ribbon in one stroke, then the screen slides up.
 */
export function Loader() {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<"draw" | "lift" | "gone">(reduce ? "gone" : "draw");
  const [vw, vh] = [window.innerWidth, window.innerHeight];

  useEffect(() => {
    if (reduce) return;
    const a = setTimeout(() => setPhase("lift"), (LINE + MARK + HOLD) * 1000);
    const b = setTimeout(() => setPhase("gone"), (LINE + MARK + HOLD + LIFT) * 1000 + 50);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [reduce]);

  if (phase === "gone") return null;

  // Fit the mark to about 40% of the screen height, centred; its start point sits on the mid line.
  const k = Math.min(vh * 0.4, vw * 0.55) / RIBBON_VIEWBOX.h;
  const tx = vw / 2 - (RIBBON_VIEWBOX.x + RIBBON_VIEWBOX.w / 2) * k;
  const ty = vh / 2 - RIBBON_START.y * k;
  const joinX = tx + RIBBON_START.x * k;

  return (
    <motion.div
      className={s.root}
      aria-hidden="true"
      animate={phase === "lift" ? { y: "-100%" } : { y: 0 }}
      transition={{ duration: LIFT, ease: [0.7, 0, 0.2, 1] }}
    >
      <svg width={vw} height={vh} className={s.svg}>
        <g fill="none" stroke="var(--brand-red)" strokeLinejoin="round" strokeLinecap="butt">
          <motion.path
            d={`M0 ${vh / 2} H${joinX}`}
            strokeWidth={RIBBON_WIDTH * k}
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: LINE, ease: [0.4, 0, 0.7, 1] }}
          />
          <g transform={`translate(${tx} ${ty}) scale(${k})`}>
            <motion.path
              d={RIBBON_D}
              strokeWidth={RIBBON_WIDTH}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{
                pathLength: { delay: LINE, duration: MARK, ease: [0.3, 0, 0.3, 1] },
                opacity: { delay: LINE, duration: 0.01 },
              }}
            />
          </g>
        </g>
      </svg>
    </motion.div>
  );
}
