import { motion, type HTMLMotionProps } from "motion/react";
import { useReducedMotion } from "../../lib/useReducedMotion";

type Props = HTMLMotionProps<"div"> & { caseId: string };

/**
 * A surface that grows out of, and back into, another surface with the same caseId
 * (a card opening into its detail panel). Interruptible: tapping back mid-way reverses it.
 */
export function Case({ caseId, transition, ...rest }: Props) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      layoutId={caseId}
      transition={reduce ? { duration: 0 } : (transition ?? { type: "spring", stiffness: 260, damping: 32 })}
      {...rest}
    />
  );
}
