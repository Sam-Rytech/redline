import type { LoanView } from "@redline/api-types";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { useNavigate, useParams } from "react-router";
import { useApi } from "../../lib/useApi";
import { useMe } from "../../lib/useMe";
import { LoanCard } from "../loans/LoanCard";
import { LoanDetail } from "../loans/LoanDetail";
import { SignInPrompt } from "./SignInPrompt";
import s from "./Account.module.css";

export function MyLoans() {
  const { me, signedOut } = useMe();
  const { data, loading } = useApi<LoanView[]>(me ? "/me/loans" : null);
  const { id } = useParams();
  const navigate = useNavigate();
  const open = id ? data?.find((l) => l.id === id) : undefined;

  return (
    <main className={s.page}>
      <h1 className={`${s.h1} display`}>My loans</h1>
      {signedOut && <SignInPrompt what="see the loans your wallet holds" />}
      {me && (
        <LayoutGroup>
          <div className={s.list} aria-busy={loading}>
            {data?.map((l) => <LoanCard key={l.id} loan={l} to={`/me/loans/${l.id}`} />)}
            {data && data.length === 0 && (
              <p className={s.prompt}>This wallet holds no ParyonUSD loans. Loans you open in Paryon show up here on the next block.</p>
            )}
          </div>
          <AnimatePresence>{open && <LoanDetail key={open.id} loan={open} onClose={() => navigate("/me")} />}</AnimatePresence>
        </LayoutGroup>
      )}
    </main>
  );
}
