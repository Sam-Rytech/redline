import { Outlet, ScrollRestoration } from "react-router";
import { Loader } from "../../ui/Loader";
import { Banner } from "./Banner";
import { ConsentNotice } from "./ConsentNotice";
import { Footer } from "./Footer";
import { Nav } from "./Nav";
import s from "./Shell.module.css";

export function Shell() {
  return (
    <>
      <Loader />
      <a className={s.skip} href="#main">Skip to content</a>
      <Banner />
      <Nav />
      <div id="main">
        <Outlet />
      </div>
      <Footer />
      <ConsentNotice />
      <ScrollRestoration />
    </>
  );
}
