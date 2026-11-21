import { NavLink, Outlet, ScrollRestoration } from "react-router";
import { Loader } from "../../ui/Loader";
import { Wordmark } from "../../ui/Wordmark";
import { ConsentNotice } from "./ConsentNotice";
import { Footer } from "./Footer";
import s from "./Shell.module.css";

export function Shell() {
  return (
    <>
      <Loader />
      <a className={s.skip} href="#main">Skip to content</a>
      <div className={`${s.banner} mono`}>
        <span>BCH BLAZE 2026 entry</span>
        <span className={s.bannerMore}>Started 17 Nov 2026, no pre-hackathon code</span>
        <a href="https://github.com/Sam-Rytech/redline" rel="noreferrer">Source</a>
      </div>
      <header className={`${s.bar} glass`}>
        <NavLink to="/" className={s.home} aria-label="Redline home">
          <Wordmark size={26} />
        </NavLink>
        <nav className={s.nav} aria-label="Main">
          <NavLink to="/loans" className={navCls}>Loans</NavLink>
          <NavLink to="/alerts" className={navCls}>Alerts</NavLink>
          <NavLink to="/pro" className={navCls}>Pro pass</NavLink>
          <NavLink to="/me" className={navCls}>My loans</NavLink>
        </nav>
      </header>
      <div id="main">
        <Outlet />
      </div>
      <Footer />
      <ConsentNotice />
      <ScrollRestoration />
    </>
  );
}

const navCls = ({ isActive }: { isActive: boolean }) => `${s.link} mono ${isActive ? s.active : ""}`;
