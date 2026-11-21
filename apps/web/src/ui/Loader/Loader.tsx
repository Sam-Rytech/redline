import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useReducedMotion } from "../../lib/useReducedMotion";
import s from "./Loader.module.css";

const KEY = "rl_loader_seen";

function seen(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Brand loader, once per session: the red line draws, the lamp blinks, the page rises. */
export function Loader() {
  const reduce = useReducedMotion();
  const [show, setShow] = useState(() => !seen());

  useEffect(() => {
    if (!show) return;
    try {
      sessionStorage.setItem(KEY, "1");
    } catch {
      /* storage blocked: the loader still runs once per page load */
    }
    const t = setTimeout(() => setShow(false), reduce ? 0 : 1300);
    return () => clearTimeout(t);
  }, [show, reduce]);

  return (
    <AnimatePresence>
      {show && !reduce && (
        <motion.div
          className={s.loader}
          initial={{ clipPath: "inset(0 0 0 0)" }}
          exit={{ clipPath: "inset(0 0 100% 0)" }}
          transition={{ duration: 0.45, ease: [0.4, 0, 1, 1] }}
          aria-hidden="true"
        >
          <div className={s.track}>
            <motion.span
              className={s.line}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.7, ease: [0.2, 0, 0, 1] }}
            />
            <motion.span
              className={s.lamp}
              initial={{ opacity: 0.25 }}
              animate={{ opacity: [0.25, 1, 0.3, 1] }}
              transition={{ delay: 0.6, duration: 0.6, times: [0, 0.3, 0.6, 1] }}
            />
          </div>
          <span className={`${s.word} mono`}>Redline</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
