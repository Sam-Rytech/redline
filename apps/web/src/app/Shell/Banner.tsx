import { useState } from "react";
import s from "./Banner.module.css";

const REPO_URL = "https://github.com/Sam-Rytech/redline";
const SLIDES_URL = "https://docs.google.com/presentation/d/1RhYt61YBA801_nemP1UZiWbBInaKmgN5Hq32Rngg35U/view";
const TOKEN_ADDRESS: string | undefined = import.meta.env.VITE_BLAZE_TOKEN_ADDRESS || undefined;

/** BCH BLAZE strip on every page: slides, source, CashTokens address and the start date. */
export function Banner() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!TOKEN_ADDRESS) return;
    try {
      await navigator.clipboard.writeText(TOKEN_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <aside className={`${s.banner} mono`} aria-label="BCH BLAZE 2026 entry">
      <span className={s.event}>BCH BLAZE 2026</span>
      <span className={s.started}>Started 17 Nov 2026, no pre-hackathon code</span>
      <span className={s.links}>
        <a href={SLIDES_URL} target="_blank" rel="noreferrer">Slides</a>
        <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub: Sam-Rytech/redline</a>
        {TOKEN_ADDRESS ? (
          <button type="button" className={s.address} onClick={copy} title={TOKEN_ADDRESS} aria-label={`Copy CashTokens address for EMBER2026 votes: ${TOKEN_ADDRESS}`}>
            <span className={s.addressLabel}>Vote EMBER2026</span>
            <span className={s.addressText}>{TOKEN_ADDRESS}</span>
            <span className={s.copy} aria-live="polite">{copied ? "Copied" : "Copy"}</span>
          </button>
        ) : (
          <span className={s.missing}>CashTokens address missing</span>
        )}
      </span>
    </aside>
  );
}
