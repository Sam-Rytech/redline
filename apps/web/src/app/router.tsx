import { createBrowserRouter } from "react-router";
import { Shell } from "./Shell/Shell";
import { Landing } from "../features/landing/Landing";
import { LoansPage } from "../features/loans/LoansPage";
import { SignIn } from "../features/auth/SignIn";
import { MyLoans } from "../features/account/MyLoans";
import { Alerts } from "../features/account/Alerts";
import { ProPass } from "../features/account/ProPass";
import { LegalPage } from "../features/legal/LegalPage";
import { NotFound } from "./NotFound";
import { RibbonLab } from "../features/lab/RibbonLab";
import { RibbonStill } from "../features/lab/RibbonStill";

export const router = createBrowserRouter([
  ...(import.meta.env.DEV ? [{ path: "/lab/ribbon-still", element: <RibbonStill /> }] : []),
  {
    element: <Shell />,
    children: [
      { index: true, element: <Landing /> },
      { path: "loans", element: <LoansPage /> },
      { path: "loans/:id", element: <LoansPage /> },
      { path: "sign-in", element: <SignIn /> },
      { path: "me", element: <MyLoans /> },
      { path: "me/loans/:id", element: <MyLoans /> },
      { path: "alerts", element: <Alerts /> },
      { path: "pro", element: <ProPass /> },
      { path: "legal/:doc", element: <LegalPage /> },
      ...(import.meta.env.DEV ? [{ path: "lab/ribbon", element: <RibbonLab /> }] : []),
      { path: "*", element: <NotFound /> },
    ],
  },
]);
