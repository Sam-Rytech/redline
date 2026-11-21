import type { Invoice, InvoiceQuote, Utxo } from "@redline/api-types";
import { PRO_PASS_DAYS, PRO_PASS_USD } from "@redline/api-types";
import { useCallback, useState } from "react";
import { api } from "../../lib/api";
import { demoWalletEnabled } from "../../lib/demoWallet";
import { useApi } from "../../lib/useApi";
import { useMe } from "../../lib/useMe";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { SignInPrompt } from "./SignInPrompt";
import s from "./Account.module.css";

type Pay = { stage: "idle" } | { stage: "waiting" } | { stage: "paid"; invoice: Invoice } | { stage: "failed"; message: string };

export function ProPass() {
  const { me, signedOut, reload } = useMe();
  const quote = useApi<InvoiceQuote>(me && !me.pro ? "/invoices/quote" : null);
  const [pay, setPay] = useState<Pay>({ stage: "idle" });
  const bch = quote.data ? (quote.data.amountSats / 1e8).toFixed(6) : null;
  const close = useCallback(() => setPay({ stage: "idle" }), []);

  // Payment is never optimistic: the modal shows a pending state until the server confirms.
  const start = async () => {
    setPay({ stage: "waiting" });
    try {
      const utxos = await api<Utxo[]>("/utxos?addresses=demo");
      const inv = await api<Invoice>("/invoices", { method: "POST", json: { asset: "BCH", inputs: utxos.slice(0, 1).map((u) => ({ txid: u.txid, vout: u.vout })) } });
      const paid = await api<Invoice>(`/invoices/${inv.id}/submit`, { method: "POST", json: { signedTxHex: "00" } });
      setPay({ stage: "paid", invoice: paid });
      reload();
    } catch (e) {
      setPay({ stage: "failed", message: (e as Error).message });
    }
  };

  return (
    <main className={s.page}>
      <h1 className={`${s.h1} display`}>Pro pass</h1>
      <section className={s.block}>
        <ul className={s.features}>
          <li>Watch every loan you hold, not just one</li>
          <li>Loan-gone alerts as well as liquidation alerts</li>
          <li>Paid in BCH from your own wallet</li>
        </ul>
        {signedOut && <SignInPrompt what="buy the Pro pass" />}
        {me?.pro && <p className={s.body}>Pro is active until {me.proUntil ? new Date(me.proUntil).toLocaleDateString() : "the end of the pass"}.</p>}
        {me && !me.pro && (
          <div className={s.buy}>
            <Button onClick={start} disabled={!demoWalletEnabled} state={pay.stage === "waiting" ? "working" : "idle"} aria-describedby="pro-terms">
              Pay {PRO_PASS_USD.toFixed(2)} USD in BCH
            </Button>
            <p id="pro-terms" className={s.terms}>
              {PRO_PASS_USD.toFixed(2)} USD, paid once in BCH{bch ? ` (about ${bch} BCH at today's price)` : ""}. Lasts {PRO_PASS_DAYS} days.
              Does not renew. You are not charged again. Nothing to cancel.
            </p>
            {demoWalletEnabled && <p className={s.small}>Development build: pays with the demo wallet on the mock server.</p>}
          </div>
        )}
      </section>
      <Modal
        open={pay.stage !== "idle"}
        onClose={close}
        tone={pay.stage === "paid" ? "done" : pay.stage === "failed" ? "bad" : "wait"}
        title={pay.stage === "paid" ? "Pro is on" : pay.stage === "failed" ? "Payment didn't go through" : "Approve in your wallet"}
        actions={
          pay.stage === "waiting" ? (
            <Button variant="secondary" onClick={close}>Hide</Button>
          ) : (
            <Button onClick={close}>{pay.stage === "paid" ? "Done" : "Close"}</Button>
          )
        }
      >
        {pay.stage === "waiting" && <p role="status">This page waits for the network to confirm the payment.</p>}
        {pay.stage === "paid" && (
          <>
            <p>Pro runs for {PRO_PASS_DAYS} days and does not renew.</p>
            <p className="mono">Receipt {pay.invoice.id}</p>
            {pay.invoice.txid && <p className="mono">Transaction {pay.invoice.txid.slice(0, 16)}…</p>}
          </>
        )}
        {pay.stage === "failed" && <p role="alert">{pay.message}. No BCH left your wallet.</p>}
      </Modal>
    </main>
  );
}
