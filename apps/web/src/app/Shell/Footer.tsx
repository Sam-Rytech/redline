import { Link } from "react-router";
import { CookieIcon, DeckIcon, GitHubIcon } from "./icons";
import { REPO_URL, SLIDES_URL } from "./links";
import s from "./Footer.module.css";

/** The top half of a large outlined wordmark, then one line: icon links and legal links. */
export function Footer() {
  return (
    <footer className={s.footer}>
      <p className={`${s.wordmark} display`} aria-hidden="true"><span>Redline</span></p>
      <div className={s.base}>
        <div className={s.icons}>
          <a className={s.round} href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="Redline on GitHub"><GitHubIcon /></a>
          <a className={s.round} href={SLIDES_URL} target="_blank" rel="noopener noreferrer" aria-label="The Redline slides"><DeckIcon /></a>
        </div>
        <nav className={s.legal} aria-label="Legal">
          <Link to="/legal/terms">Terms</Link>
          <Link to="/legal/privacy">Privacy</Link>
          <Link className={s.legalIcon} to="/legal/cookies" aria-label="Cookie policy"><CookieIcon /></Link>
        </nav>
      </div>
    </footer>
  );
}
