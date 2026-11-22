import { useState } from "react";
import { DeckIcon, GitHubIcon } from "./icons";
import { REPO_URL, SLIDES_URL } from "./links";
import s from "./Banner.module.css";

const TOKEN_ADDRESS: string | undefined = import.meta.env.VITE_BLAZE_TOKEN_ADDRESS || undefined;
const SHORT_ADDRESS = TOKEN_ADDRESS && `${TOKEN_ADDRESS.slice(0, 16)}…${TOKEN_ADDRESS.slice(-4)}`;

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
      <span className={s.started}><span className={s.nowrap}>First commit 20 Nov 2026,</span> <span className={s.nowrap}>no pre-hackathon code</span></span>
      <span className={s.icons}>
        <a className={s.icon} href={SLIDES_URL} target="_blank" rel="noreferrer" aria-label="Slides" title="Slides">
          <DeckIcon /><span className={s.iconLabel}>Slides</span>
        </a>
        <a className={s.icon} href={REPO_URL} target="_blank" rel="noreferrer" aria-label="GitHub: Sam-Rytech/redline" title="GitHub: Sam-Rytech/redline">
          <GitHubIcon /><span className={s.iconLabel}>GitHub</span>
        </a>
      </span>
      {TOKEN_ADDRESS ? (
        <button type="button" className={s.address} onClick={copy} title={TOKEN_ADDRESS} aria-label={`Copy CashTokens address for EMBER2026 votes: ${TOKEN_ADDRESS}`}>
          <span className={s.addressLabel}>Vote EMBER2026</span>
          <span className={s.addressText}>{SHORT_ADDRESS}</span>
          <span className={s.copy} aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      ) : (
        <span className={s.missing}>CashTokens address missing</span>
      )}
    </aside>
  );
}
