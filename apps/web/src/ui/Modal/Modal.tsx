import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { RIBBON_CLIP, RIBBON_D, RIBBON_VIEWBOX, RIBBON_WIDTH } from "../Logo/ribbon";
import s from "./Modal.module.css";

/** done and wait: red band. bad: ink band. */
export type ModalTone = "done" | "wait" | "bad";

const { x, y, w, h } = RIBBON_VIEWBOX;

type Props = {
  open: boolean;
  onClose: () => void;
  tone: ModalTone;
  title: string;
  children?: ReactNode;
  /** Buttons under the text. */
  actions?: ReactNode;
};

/** Every alert and response: a card in a frosted ring, the ribbon drawn in one stroke over a band of clouds. Escape and the backdrop close it. */
export function Modal({ open, onClose, tone, title, children, actions }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const clipId = `ribbon-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className={s.root}>
          <motion.div className={s.scrim} onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }} />
          <motion.div
            ref={ref}
            className={s.ring}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.96 }}
            transition={{ duration: 0.36, ease: [0.2, 0.7, 0.2, 1] }}
          >
            <div className={s.card}>
              <div className={`${s.band} ${tone === "bad" ? s.bandBad : ""}`} aria-hidden="true">
                <span className={`${s.halo} ${s.haloA}`} />
                <span className={`${s.halo} ${s.haloB}`} />
                <span className={`${s.spark} ${s.sparkA}`} />
                <span className={`${s.spark} ${s.sparkB}`} />
                <span className={`${s.spark} ${s.sparkC}`} />
                <svg className={s.art} viewBox={`${x} ${y} ${w} ${h}`}>
                  <defs>
                    <clipPath id={clipId}>
                      <path d={RIBBON_CLIP} />
                    </clipPath>
                  </defs>
                  <path
                    className={s.ribbon}
                    d={RIBBON_D}
                    pathLength={1}
                    clipPath={`url(#${clipId})`}
                    strokeWidth={RIBBON_WIDTH}
                  />
                </svg>
                <span className={s.clouds} />
              </div>
              <div className={s.body}>
                <h2 id={titleId} className={s.title}>{title}</h2>
                {children && <div className={s.text}>{children}</div>}
                {actions && <div className={s.actions}>{actions}</div>}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
