import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { ButtonLink } from "../../ui/Button";
import { Logo } from "../../ui/Logo";
import { GitHubIcon } from "./icons";
import { APP_LINKS, REPO_URL } from "./links";
import s from "./AppNav.module.css";

/** Inside the app: logo, then the sections with the current one in a pill, then GitHub and Connect wallet. */
export function AppNav() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className={s.header}>
      <div className={s.bar}>
        <NavLink to="/" className={s.brand} aria-label="Redline home">
          <Logo size={22} />
        </NavLink>
        <nav className={s.links} aria-label="Main">
          {APP_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => `${s.link} ${isActive ? s.active : ""}`}>
              <span className={s.pill}>{l.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className={s.actions}>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={s.iconBtn} aria-label="GitHub repository">
            <GitHubIcon />
          </a>
          <ButtonLink to="/sign-in" className={s.cta}>Connect wallet</ButtonLink>
          <button className={s.toggle} aria-expanded={open} aria-controls="app-menu" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((o) => !o)}>
            <span className={`${s.bars} ${open ? s.x : ""}`} aria-hidden="true" />
          </button>
        </div>
      </div>
      <AnimatePresence>
        {open && (
          <motion.nav
            id="app-menu"
            className={s.menu}
            aria-label="Main"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
          >
            {APP_LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => `${s.menuLink} ${isActive ? s.menuActive : ""}`}>{l.label}</NavLink>
            ))}
            <a className={s.menuLink} href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
            <ButtonLink to="/sign-in">Connect wallet</ButtonLink>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
