import { AnimatePresence, motion } from "motion/react";
import { Fragment, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { ButtonLink } from "../../ui/Button";
import { Logo } from "../../ui/Logo";
import { APP_LINKS as LINKS } from "./links";
import s from "./Nav.module.css";


/** Clear over the page at the top, frosted once you scroll. Links fold into a menu on phones. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className={`${s.nav} ${scrolled || open ? s.scrolled : ""}`}>
      <div className={s.inner}>
        <NavLink to="/" className={s.home} aria-label="Redline home">
          <Logo size={30} />
        </NavLink>
        <nav className={s.links} aria-label="Main">
          {LINKS.map((l, i) => (
            <Fragment key={l.to}>
              {i > 0 && <span className={s.bullet} aria-hidden="true" />}
              <NavLink to={l.to} className={({ isActive }) => `${s.link} ${isActive ? s.active : ""}`}>
                {l.label}
              </NavLink>
            </Fragment>
          ))}
        </nav>
        <div className={s.end}>
          <ButtonLink to="/sign-in" className={s.cta}>Connect wallet</ButtonLink>
          <button className={s.toggle} aria-expanded={open} aria-controls="nav-menu" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((o) => !o)}>
            <span className={`${s.bars} ${open ? s.x : ""}`} aria-hidden="true" />
          </button>
        </div>
      </div>
      <AnimatePresence>
        {open && (
          <motion.nav
            id="nav-menu"
            className={s.menu}
            aria-label="Main"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
          >
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className={s.menuLink}>{l.label}</NavLink>
            ))}
            <ButtonLink to="/sign-in">Connect wallet</ButtonLink>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
