import { motion, useInView, type Variants } from "motion/react";
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { introDelay } from "../Loader";

/** How an element arrives: drops from above, slides in from a side, or pops up in place. Every one lands with a bounce. */
export type From = "fall" | "left" | "right" | "pop" | "none";

const BOP = { type: "spring", stiffness: 420, damping: 16, mass: 0.9 } as const;
const FADE = { duration: 0.3, ease: "easeOut" } as const;

const START: Record<From, Record<string, number>> = {
  fall: { y: -56, rotate: -1.5 },
  left: { x: -110, scale: 0.94 },
  right: { x: 110, scale: 0.94 },
  pop: { scale: 0.82, y: 12 },
  none: {},
};
const END = { x: 0, y: 0, scale: 1, rotate: 0 };

function variants(from: From, reduce: boolean, stagger?: { each: number; after: number }): Variants {
  const orchestrate = stagger ? { staggerChildren: stagger.each, delayChildren: stagger.after } : {};
  if (reduce) return { hidden: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.2, ...orchestrate } } };
  return {
    hidden: { opacity: 0, ...START[from] },
    show: { opacity: 1, ...END, transition: { ...BOP, opacity: FADE, ...orchestrate } },
  };
}

const InGroup = createContext(false);
type Tag = "div" | "span" | "p" | "h1" | "h2" | "dl" | "li" | "article" | "section" | "header";

type Props = { from?: From; as?: Tag; className?: string; children?: ReactNode; delay?: number; id?: string };

/** Animates its element in the first time it scrolls into view. Inside a RevealGroup it waits for the group's cue. */
export function Reveal({ from = "fall", as = "div", className, children, delay = 0, id }: Props) {
  const grouped = useContext(InGroup);
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.15 });
  const v = useMemo(() => variants(from, reduce), [from, reduce]);
  // The delay is read when the element enters view, so the first screen waits for the preloader to lift.
  const wait = useMemo(() => (inView ? introDelay() + delay : 0), [inView, delay]);
  const M = motion[as] as typeof motion.div;
  if (grouped) return <M ref={ref as never} id={id} className={className} variants={v}>{children}</M>;
  return (
    <M
      ref={ref as never}
      id={id}
      className={className}
      variants={v}
      initial="hidden"
      animate={inView ? "show" : "hidden"}
      transition={{ delay: wait }}
    >
      {children}
    </M>
  );
}

/** Reveals its children one after another when it scrolls into view; the group itself arrives first. */
export function RevealGroup({ from = "fall", as = "div", className, children, each = 0.07, delay = 0, id }: Props & { each?: number }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.15 });
  const after = useMemo(() => (inView ? introDelay() + delay : 0), [inView, delay]);
  const v = useMemo(() => {
    const base = variants(from, reduce, { each, after: after + 0.08 });
    const show = base.show as { transition?: object };
    return { ...base, show: { ...show, transition: { ...show.transition, delay: after } } } as Variants;
  }, [from, reduce, each, after]);
  const M = motion[as] as typeof motion.div;
  return (
    <InGroup.Provider value={true}>
      <M ref={ref as never} id={id} className={className} variants={v} initial="hidden" animate={inView ? "show" : "hidden"}>
        {children}
      </M>
    </InGroup.Provider>
  );
}
