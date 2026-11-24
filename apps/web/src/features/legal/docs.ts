// Draft legal text. Every document here needs review by a lawyer before launch.
export type LegalDoc = { title: string; updated: string; sections: { h: string; p: string[] }[] };

export const LEGAL: Record<string, LegalDoc> = {
  terms: {
    title: "Terms of use",
    updated: "24 November 2026",
    sections: [
      { h: "Who we are", p: ["Redline is built and run by Namite Studio, a remote studio. In these terms, “we” means Namite Studio.", "Redline is an independent project, not affiliated with ParyonUSD. It is not made, run or endorsed by ParyonUSD or its developers."] },
      { h: "What Redline does", p: ["Redline reads ParyonUSD loans from the Bitcoin Cash chain and sends alerts about them. It cannot move, repay or change any loan. Every action on a loan happens in your own wallet and in Paryon."] },
      { h: "Alerts are best effort", p: ["Alerts depend on chain data, price data, our servers and Telegram. They can be late, wrong or missed. Do not rely on Redline as your only way of watching a loan.", "Redline is not financial advice. Decisions about your loans are yours."] },
      { h: "The Pro pass", p: ["The Pro pass costs 0.25 USD, paid once in BCH at the price shown before you pay. It lasts 30 days from payment and does not renew. You are never charged again unless you buy another pass. There is nothing to cancel.", "Payments on Bitcoin Cash cannot be reversed. If a pass does not activate after a confirmed payment, contact us through the project's source repository and we will put it right."] },
      { h: "Age", p: ["You must meet the minimum age shown at sign-in to create an account."] },
      { h: "Changes", p: ["We may update these terms. The date at the top shows the latest version."] },
    ],
  },
  privacy: {
    title: "Privacy policy",
    updated: "24 November 2026",
    sections: [
      { h: "Who is responsible", p: ["Namite Studio runs Redline and is responsible for the data described here."] },
      { h: "What we store", p: ["A hash that identifies your account, your plan and when Pro ends, your Telegram chat id if you connect Telegram, the loans you watch and the alerts we sent you, and your signed-in session.", "We do not store your name, email address or date of birth. The age screen keeps only whether you passed."] },
      { h: "What signing in reveals", p: ["To find your loans, signing in shares your wallet's public keys (xpubs) and one unspent output with our server. The keys are kept only in your session and are deleted when it ends."] },
      { h: "What we do not do", p: ["No analytics, no tracking, no advertising, no session recording. We do not sell or share your data."] },
      { h: "How long we keep it", p: ["Account data stays while your account exists. Sessions end after 30 days of inactivity. Alert history is kept for 90 days."] },
      { h: "Deleting your data", p: ["You can delete your account and everything linked to it from the account screen at any time. Deletion is immediate."] },
    ],
  },
  cookies: {
    title: "Cookie policy",
    updated: "21 November 2026",
    sections: [
      { h: "The cookies we set", p: ["rl_session keeps you signed in. rl_ch ties a sign-in request to your browser so nobody else can complete it. rl_age remembers the result of the age screen.", "All three are strictly necessary for the service to work, so they need no consent. We set no other cookies."] },
      { h: "Browser storage", p: ["We remember in your browser that you have seen the cookie notice and the intro animation. Nothing in it leaves your device."] },
      { h: "Third parties", p: ["None. Fonts are served from our own domain and there are no analytics or advertising scripts."] },
    ],
  },
};
