import s from "./Wordmark.module.css";

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className={s.mark} style={{ fontSize: size }} aria-label="Redline">
      RED<span className={s.red}>LINE</span>
    </span>
  );
}
