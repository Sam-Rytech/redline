import type { LoanView } from "@redline/api-types";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { useNavigate, useParams } from "react-router";
import { useApi } from "../../lib/useApi";
import { useMe } from "../../lib/useMe";
import { LoanCard } from "../loans/LoanCard";
import { LoanDetail } from "../loans/LoanDetail";
import { SignInPrompt } from "./SignInPrompt";
import { Reveal } from "../../ui/Reveal";
import s from "./Account.module.css";

export function MyLoans() {
  const { me, signedOut } = useMe();
  const { data, loading } = useApi<LoanView[]>(me ? "/me/loans" : null);
  const { id } = useParams();
  const navigate = useNavigate();
  const open = id ? data?.find((l) => l.id === id) : undefined;

  return (
    <main className={s.page}>
      <Reveal as="h1" className={`${s.h1} display`}>My loans</Reveal>
      {signedOut && <SignInPrompt what="see the loans your wallet holds" />}
      {me && (
        <LayoutGroup>
          <div className={s.list} aria-busy={loading}>
            {data?.map((l, i) => (
              <Reveal key={l.id} from="pop" delay={(i % 3) * 0.06} className={s.cardSlot}>
                <LoanCard loan={l} to={`/me/loans/${l.id}`} />
              </Reveal>
            ))}
            {data && data.length === 0 && (
              <Reveal from="pop">
                <p className={s.prompt}>This wallet holds no ParyonUSD loans. Loans you open in Paryon show up here on the next block.</p>
              </Reveal>
            )}
          </div>
          <AnimatePresence>{open && <LoanDetail key={open.id} loan={open} onClose={() => navigate("/me")} />}</AnimatePresence>
        </LayoutGroup>
      )}
    </main>
  );
}
