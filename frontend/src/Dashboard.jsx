import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { KIND_LABEL, cap, formatDate, isCredit, money } from "./format.js";
import SideMenu from "./SideMenu.jsx";
import BluetoothPay from "./BluetoothPay.jsx";
import Fingerprint from "./Fingerprint.jsx";
import Business from "./Business.jsx";

const ACTIONS = ["deposit", "withdraw", "transfer"];
const DONE_LABEL = {
  deposit: "Deposit complete",
  withdraw: "Withdrawal complete",
  transfer: "Transfer complete",
  bluetooth: "Bluetooth payment sent",
};
const TITLES = {
  accounts: ["Your accounts", "Balances and account numbers."],
  move: ["Move money", "Deposit, withdraw or transfer."],
  history: ["Transactions", "Everything that happened on an account."],
  bluetooth: ["Bluetooth Pay", "Pay a nearby device straight from your account."],
  fingerprint: ["Fingerprint Pay", "Pay with a tap of your finger."],
  business: ["Business", "Take fingerprint payments: prices on your phone, fingerprint on your Mac."],
};

export default function Dashboard({ user, onLogout, theme, onTheme }) {
  const [view, setView] = useState("accounts");
  const [menuOpen, setMenuOpen] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [history, setHistory] = useState([]);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);

  const flash = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2600);
  };

  const loadAccounts = useCallback(async () => {
    const list = await api("/accounts");
    setAccounts(list);
    setSelectedId((cur) => (list.some((a) => a.id === cur) ? cur : list[0]?.id ?? null));
  }, []);

  useEffect(() => { loadAccounts().catch(() => {}); }, [loadAccounts]);

  const loadHistory = useCallback(async () => {
    if (!selectedId) return setHistory([]);
    setHistory(await api(`/accounts/${selectedId}/transactions`));
  }, [selectedId]);

  useEffect(() => { loadHistory().catch(() => {}); }, [loadHistory, accounts]);

  const total = accounts.reduce((sum, a) => sum + a.balance, 0);

  const openAccount = async (type) => {
    try {
      const acct = await api("/accounts", { method: "POST", body: { type } });
      await loadAccounts();
      setSelectedId(acct.id);
      flash(`${type} account opened`);
    } catch (ex) {
      flash(ex.message);
    }
  };

  const done = async (action) => { await loadAccounts(); flash(DONE_LABEL[action]); };
  const [title, sub] = TITLES[view];

  return (
    <div>
      <SideMenu open={menuOpen} setOpen={setMenuOpen} view={view} onSelect={setView}
        theme={theme} onTheme={onTheme} onLogout={onLogout} />

      <header className="topbar">
        <div className="topbar-left">
          <button className="menu-btn" type="button" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <div className="brand"><span className="logo">N</span> Nexus</div>
        </div>
        <div className="user"><span>{user.name}</span></div>
      </header>

      <main className="layout">
        <div>
          <h1 className="view-title">{title}</h1>
          <p className="view-sub">{sub}</p>
        </div>

        {view === "accounts" && (
          <section className="panel">
            <div className="panel-head">
              <h2>Accounts</h2>
              <div className="row">
                <button className="btn ghost" type="button" onClick={() => openAccount("checking")}>+ Checking</button>
                <button className="btn ghost" type="button" onClick={() => openAccount("savings")}>+ Savings</button>
              </div>
            </div>
            <div className="total"><span>Total balance</span><strong>{money(total)}</strong></div>
            <div className="accounts">
              {accounts.map((a) => (
                <button key={a.id} type="button" onClick={() => setSelectedId(a.id)}
                  className={"account" + (a.id === selectedId ? " selected" : "")}>
                  <div>
                    <div className="type">{a.type}</div>
                    <div className="num">{a.number}</div>
                  </div>
                  <div className="bal">{money(a.balance)}</div>
                </button>
              ))}
            </div>
          </section>
        )}

        {view === "move" && <MoneyForm accounts={accounts} defaultId={selectedId} onDone={done} />}

        {view === "bluetooth" && (
          <BluetoothPay accounts={accounts} defaultId={selectedId} onDone={() => done("bluetooth")} />
        )}

        {view === "fingerprint" && <Fingerprint accounts={accounts} onChanged={loadAccounts} />}

        {view === "business" && <Business accounts={accounts} onChanged={loadAccounts} />}

        {view === "history" && (
          <section className="panel">
            <div className="panel-head">
              <h2>History</h2>
              <select value={selectedId ?? ""} onChange={(e) => setSelectedId(Number(e.target.value))}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{cap(a.type)} · {a.number}</option>
                ))}
              </select>
            </div>
            <table>
              <thead>
                <tr><th>Date</th><th>Type</th><th>Details</th><th className="num">Amount</th><th className="num">Balance</th></tr>
              </thead>
              <tbody>
                {history.map((t) => {
                  const credit = isCredit(t.kind);
                  return (
                    <tr key={t.id}>
                      <td>{formatDate(t.created_at)}</td>
                      <td>{KIND_LABEL[t.kind]}</td>
                      <td>{[t.counterparty, t.note].filter(Boolean).join(" · ") || "—"}</td>
                      <td className={"num " + (credit ? "pos" : "neg")}>{credit ? "+" : "−"}{money(t.amount)}</td>
                      <td className="num">{money(t.balance_after)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {history.length === 0 && <p className="muted">No transactions yet.</p>}
          </section>
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function MoneyForm({ accounts, defaultId, onDone }) {
  const [action, setAction] = useState("deposit");
  const [accountId, setAccountId] = useState(defaultId);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Follow the selected account until the user picks one here.
  useEffect(() => {
    setAccountId((cur) => (accounts.some((a) => a.id === cur) ? cur : defaultId));
  }, [accounts, defaultId]);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    const payload = action === "transfer"
      ? { from_account_id: Number(accountId), to_account_number: to, amount, note }
      : { account_id: Number(accountId), amount, note };
    try {
      await api(`/${action}`, { method: "POST", body: payload });
      setAmount(""); setNote(""); setTo("");
      await onDone(action);
    } catch (ex) {
      setError(ex.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="tabs small">
        {ACTIONS.map((a) => (
          <button key={a} type="button" className={"tab" + (a === action ? " active" : "")}
            onClick={() => { setAction(a); setError(""); }}>{cap(a)}</button>
        ))}
      </div>
      <form onSubmit={submit}>
        <label>Account
          <select value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{cap(a.type)} · {a.number}</option>
            ))}
          </select>
        </label>
        {action === "transfer" && (
          <label>To account number
            <input type="text" placeholder="NX0000000000" autoComplete="off"
              value={to} onChange={(e) => setTo(e.target.value)} required />
          </label>
        )}
        <label>Amount (ETB)
          <input type="text" inputMode="decimal" placeholder="0.00"
            value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <label>Note (optional)
          <input type="text" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button className="btn primary" type="submit" disabled={busy}>{cap(action)}</button>
        <p className="error" role="alert">{error}</p>
      </form>
    </section>
  );
}
