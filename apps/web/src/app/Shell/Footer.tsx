import { Link } from "react-router";
import { Logo } from "../../ui/Logo";
import s from "./Shell.module.css";

export function Footer() {
  return (
    <footer className={s.footer}>
      <div className={s.footTop}>
        <span className={s.footLogo}><Logo size={40} /></span>
        <p className={s.footNote}>Independent project. Not affiliated with ParyonUSD. Not financial advice.</p>
      </div>
      <nav className={`${s.footLinks} mono`} aria-label="Legal">
        <Link to="/legal/terms">Terms</Link>
        <Link to="/legal/privacy">Privacy</Link>
        <Link to="/legal/cookies">Cookies</Link>
        <a href="https://github.com/Sam-Rytech/redline" rel="noreferrer">Source</a>
      </nav>
    </footer>
  );
}
