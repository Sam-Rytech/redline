import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import s from "./Sheet.module.css";

type Props = { open: boolean; onClose: () => void; title: string; children: ReactNode };

/** Modal sheet: bottom sheet on phones, centred dialog on wider screens. Escape and backdrop close it. */
export function Sheet({ open, onClose, title, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);

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
          <motion.div className={s.backdrop} onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.div
            ref={ref}
            className={s.sheet}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.2, 0, 0, 1] }}
          >
            <div className={s.head}>
              <h2 className={s.title}>{title}</h2>
              <button className={s.close} onClick={onClose} aria-label="Close">
                <svg viewBox="0 0 256 256" width="18" height="18" aria-hidden="true">
                  <path fill="currentColor" d="M208.49 191.51a12 12 0 0 1-17 17L128 145l-63.51 63.49a12 12 0 0 1-17-17L111 128 47.51 64.49a12 12 0 0 1 17-17L128 111l63.51-63.52a12 12 0 0 1 17 17L145 128Z" />
                </svg>
              </button>
            </div>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
