import { Outlet, ScrollRestoration, useLocation } from "react-router";
import { Loader } from "../../ui/Loader";
import { AppNav } from "./AppNav";
import { Banner } from "./Banner";
import { ConsentNotice } from "./ConsentNotice";
import { Footer } from "./Footer";
import { Nav } from "./Nav";
import s from "./Shell.module.css";

/** The landing page keeps its open navigation; every other page gets the app header. */
export function Shell() {
  const { pathname } = useLocation();
  return (
    <>
      <Loader />
      <a className={s.skip} href="#main">Skip to content</a>
      <Banner />
      {pathname === "/" ? <Nav /> : <AppNav />}
      <div id="main">
        <Outlet />
      </div>
      <Footer />
      <ConsentNotice />
      <ScrollRestoration />
    </>
  );
}
