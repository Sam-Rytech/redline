import type { LoanView } from "@redline/api-types";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { fmtUsd } from "../../lib/format";
import { useLoans } from "../../lib/useLoans";
import { Button } from "../../ui/Button";
import { LoanCard } from "./LoanCard";
import { LoanDetail } from "./LoanDetail";
import s from "./Loans.module.css";

type Filter = "all" | "near" | "stranded";

/** Every loan on the chain, closest to the line first. Anyone can look; no sign-in. */
export function LoansPage() {
  const { data, error, loading, reload } = useLoans();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const filter: Filter = params.get("stranded") ? "stranded" : ((params.get("f") as Filter | null) ?? "all");

  const loans = useMemo(() => {
    const all = data?.loans ?? [];
    const shown = all.filter((l) => {
      if (filter === "stranded" && !l.stranded) return false;
      if (filter === "near" && !(l.distanceToLiquidation !== null && l.distanceToLiquidation < 0.2)) return false;
      return q === "" || l.id.toLowerCase().includes(q.trim().toLowerCase());
    });
    return shown.sort(byRisk);
  }, [data, filter, q]);

  const open = id ? data?.loans.find((l) => l.id === id) : undefined;
  const setFilter = (f: Filter) => setParams(f === "all" ? {} : f === "stranded" ? { stranded: "1" } : { f });

  return (
    <main className={s.page}>
      <header className={s.head}>
        <h1 className={`${s.h1} display`}>Every loan</h1>
        <p className={s.lead}>
          {data ? `${data.summary.total} ParyonUSD loans, read from block ${data.blockHeight}. BCH at ${fmtUsd(data.priceUsd)}.` : "Reading the chain."}
        </p>
      </header>

      <div className={s.tools}>
        <label className={s.search}>
          <span className="visually-hidden">Find a loan by id</span>
          <input type="search" placeholder="Find a loan by id" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className={s.filters} role="group" aria-label="Filter loans">
          {(["all", "near", "stranded"] as const).map((f) => (
            <button key={f} className={`${s.filter} mono`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "near" ? "Near the line" : "Stranded"}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className={s.empty} role="alert">
          <p>The loan list did not load: {error.message}.</p>
          <Button variant="quiet" onClick={reload}>Try again</Button>
        </div>
      )}

      <LayoutGroup>
        <div className={s.list} aria-busy={loading}>
          {loading && !data && Array.from({ length: 6 }, (_, i) => <div key={i} className={s.skeleton} />)}
          {loans.map((l) => (
            <LoanCard key={l.id} loan={l} to={`/loans/${l.id}${params.size ? `?${params}` : ""}`} />
          ))}
          {data && loans.length === 0 && (
            <div className={s.empty}>
              <p>No loans match. Clear the search or pick another filter to see more.</p>
            </div>
          )}
        </div>
        <AnimatePresence>
          {open && <LoanDetail key={open.id} loan={open} onClose={() => navigate(`/loans${params.size ? `?${params}` : ""}`)} />}
        </AnimatePresence>
      </LayoutGroup>
    </main>
  );
}

const byRisk = (a: LoanView, b: LoanView) => (a.distanceToLiquidation ?? Infinity) - (b.distanceToLiquidation ?? Infinity);
