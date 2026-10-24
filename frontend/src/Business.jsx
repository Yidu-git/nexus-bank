import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { cap, money } from "./format.js";
import { Icon } from "./SideMenu.jsx";
import { fingerprintSupported, friendlyError, scanFingerprint, unsupportedReason } from "./webauthn.js";

const TAB_KEY = "nexus_business_tab";
const loadTab = () => { try { return localStorage.getItem(TAB_KEY) || "phone"; } catch { return "phone"; } };
const saveTab = (t) => { try { localStorage.setItem(TAB_KEY, t); } catch { /* private mode */ } };

// Calls fn every `ms` while `active`, always using the newest fn.
function usePoll(fn, ms, active) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return undefined;
    let stop = false;
    let timer;
    const tick = async () => {
      try { await ref.current(); } catch { /* keep polling */ }
      if (!stop) timer = setTimeout(tick, ms);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [ms, active]);
}

const toCents = (v) => {
  const s = String(v).trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return 0;
  const [w, f = ""] = s.split(".");
  return Number(w) * 100 + Number((f + "00").slice(0, 2));
};

/** Business area: one login, two devices. Phone = price selector, Mac = fingerprint terminal. */
export default function Business({ accounts, onChanged }) {
  const [biz, setBiz] = useState(null);
  const [tab, setTab] = useState(loadTab);
  const [error, setError] = useState("");

  const load = useCallback(async () => setBiz(await api("/merchant")), []);
  useEffect(() => { load().catch((ex) => setError(ex.message)); }, [load]);

  const pick = (t) => { setTab(t); saveTab(t); };

  if (!biz) return <section className="panel"><p className="error" role="alert">{error || "Loading…"}</p></section>;
  if (!biz.enabled) {
    return <Setup biz={biz} accounts={accounts} first onSaved={(b) => { setBiz(b); onChanged?.(); }} />;
  }

  return (
    <>
      <div className="tabs">
        <button type="button" className={"tab" + (tab === "phone" ? " active" : "")} onClick={() => pick("phone")}>Price selector</button>
        <button type="button" className={"tab" + (tab === "terminal" ? " active" : "")} onClick={() => pick("terminal")}>Fingerprint terminal</button>
        <button type="button" className={"tab" + (tab === "setup" ? " active" : "")} onClick={() => pick("setup")}>Setup</button>
      </div>
      {tab === "phone" && <PriceSelector biz={biz} onEditItems={() => pick("setup")} />}
      {tab === "terminal" && <Terminal biz={biz} />}
      {tab === "setup" && <Setup biz={biz} accounts={accounts} onSaved={(b) => { setBiz(b); onChanged?.(); }} />}
    </>
  );
}

/* ------------------------------------------------------------------ Setup */
function Setup({ biz, accounts, first, onSaved }) {
  const [name, setName] = useState(biz.name);
  const [accountId, setAccountId] = useState(biz.account_id ?? accounts[0]?.id ?? "");
  const [items, setItems] = useState(biz.items.map((i) => ({ id: i.id, name: i.name, price: String(i.price) })));
  const [msg, setMsg] = useState({ text: "", ok: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!accountId && accounts[0]) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const setItem = (idx, key) => (e) =>
    setItems(items.map((it, i) => (i === idx ? { ...it, [key]: e.target.value } : it)));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg({ text: "", ok: false });
    try {
      const saved = await api("/merchant", {
        method: "PUT",
        body: { name, account_id: Number(accountId), items: items.filter((i) => i.name.trim() || i.price.trim()) },
      });
      onSaved(saved);
      setItems(saved.items.map((i) => ({ id: i.id, name: i.name, price: String(i.price) })));
      setMsg({ text: "Saved.", ok: true });
    } catch (ex) {
      setMsg({ text: ex.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>{first ? "Set up your business" : "Business setup"}</h2>
      <form onSubmit={save}>
        <label>Business name
          <input type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>Receive payments into
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.map((a) => <option key={a.id} value={a.id}>{cap(a.type)} · {a.number}</option>)}
          </select>
        </label>

        <div>
          <div className="side-label" style={{ margin: "4px 0 8px" }}>Price list</div>
          <div className="item-rows">
            {items.map((it, idx) => (
              <div className="item-row" key={it.id ?? `new-${idx}`}>
                <input type="text" placeholder="Item name" maxLength={40} value={it.name} onChange={setItem(idx, "name")} />
                <input type="text" inputMode="decimal" placeholder="Price" value={it.price} onChange={setItem(idx, "price")} />
                <button className="btn ghost" type="button" aria-label="Remove item"
                  onClick={() => setItems(items.filter((_, i) => i !== idx))}>✕</button>
              </div>
            ))}
          </div>
          <button className="btn ghost" type="button" style={{ marginTop: 10 }}
            onClick={() => setItems([...items, { name: "", price: "" }])}>+ Add item</button>
        </div>

        <button className="btn primary" type="submit" disabled={busy}>{first ? "Create business" : "Save"}</button>
        <p className={"error" + (msg.ok ? " ok" : "")} role="alert">{msg.text}</p>
      </form>
      <p className="note">
        Open Nexus on your <strong>phone</strong> and choose “Price selector”, and on the <strong>Mac with the
        fingerprint reader</strong> choose “Fingerprint terminal”. Sign in to the same business account on both.
      </p>
    </section>
  );
}

/* --------------------------------------------------------- Price selector */
function PriceSelector({ biz, onEditItems }) {
  const [cart, setCart] = useState({});       // item id -> quantity
  const [custom, setCustom] = useState("");
  const [charge, setCharge] = useState(null); // the sale waiting for / finished with a fingerprint
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const total = biz.items.reduce((s, i) => s + toCents(i.price) * (cart[i.id] || 0), 0) + toCents(custom);
  const bump = (id, d) => setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] || 0) + d) }));

  const sell = async () => {
    setError("");
    setBusy(true);
    try {
      const items = Object.entries(cart).filter(([, q]) => q > 0).map(([id, qty]) => ({ id: Number(id), qty }));
      setCharge(await api("/merchant/charges", { method: "POST", body: { items, custom_amount: custom } }));
    } catch (ex) {
      setError(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const waiting = charge && charge.status === "pending";
  usePoll(async () => setCharge(await api(`/merchant/charges/${charge.id}`)), 1000, Boolean(waiting));

  const cancel = async () => {
    try { setCharge(await api(`/merchant/charges/${charge.id}/cancel`, { method: "POST" })); } catch (ex) { setError(ex.message); }
  };
  const reset = () => { setCharge(null); setCart({}); setCustom(""); setError(""); };

  if (charge) {
    return (
      <section className={"panel sale " + charge.status}>
        <div className="sale-amount">{money(charge.amount)}</div>
        <div className="sale-label">{charge.label}</div>
        {charge.status === "pending" && (
          <>
            <div className="sale-state"><Icon name="fingerprint" size={36} /> <span>Waiting for fingerprint on the terminal…</span></div>
            {charge.error && <p className="error" role="alert">Declined: {charge.error}</p>}
            <button className="btn" type="button" onClick={cancel}>Cancel sale</button>
          </>
        )}
        {charge.status === "paid" && (
          <>
            <div className="sale-state ok">✓ Paid{charge.customer ? ` by ${charge.customer}` : ""}</div>
            <button className="btn primary" type="button" onClick={reset}>New sale</button>
          </>
        )}
        {(charge.status === "cancelled" || charge.status === "expired") && (
          <>
            <div className="sale-state">{charge.status === "expired" ? "Timed out" : "Sale cancelled"}</div>
            <button className="btn primary" type="button" onClick={reset}>New sale</button>
          </>
        )}
        <p className="error" role="alert">{error}</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{biz.name}</h2>
        <button className="btn ghost" type="button" onClick={onEditItems}>Edit prices</button>
      </div>
      {biz.items.length === 0 && <p className="muted">No items yet. Add some under Setup, or type an amount below.</p>}
      <div className="price-grid">
        {biz.items.map((i) => {
          const q = cart[i.id] || 0;
          return (
            <div key={i.id} className={"price-tile" + (q ? " on" : "")}>
              <button type="button" className="price-main" onClick={() => bump(i.id, 1)}>
                <span className="price-name">{i.name}</span>
                <span className="price-amt">{money(i.price)}</span>
              </button>
              {q > 0 && (
                <div className="qty">
                  <button type="button" aria-label={`Remove one ${i.name}`} onClick={() => bump(i.id, -1)}>−</button>
                  <b>{q}</b>
                  <button type="button" aria-label={`Add one ${i.name}`} onClick={() => bump(i.id, 1)}>+</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <label style={{ marginTop: 16 }}>Other amount (ETB)
        <input type="text" inputMode="decimal" placeholder="0.00" value={custom} onChange={(e) => setCustom(e.target.value)} />
      </label>

      <button className="btn primary charge-btn" type="button" onClick={sell} disabled={busy || total <= 0}>
        {total > 0 ? `Charge ${money(total / 100)}` : "Pick a price"}
      </button>
      <p className="error" role="alert">{error}</p>
    </section>
  );
}

/* --------------------------------------------------------------- Terminal */
function Terminal() {
  const [on, setOn] = useState(false);
  const [charge, setCharge] = useState(null);
  const [serverTime, setServerTime] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempted = useRef(new Set());   // charges we already prompted for automatically
  const abortRef = useRef(null);

  usePoll(async () => {
    const res = await api("/merchant/terminal");
    setCharge(res.charge);
    setServerTime(res.server_time);
  }, 1000, on);

  const scan = useCallback(async (c) => {
    setBusy(true);
    setError("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const options = await api("/pay/fingerprint/options", { method: "POST", body: { charge_id: c.id } });
      const credential = await scanFingerprint(options, ctrl.signal);
      const res = await api("/pay/fingerprint/verify", { method: "POST", body: { credential } });
      setCharge(res.charge);
    } catch (ex) {
      if (!ctrl.signal.aborted) setError(friendlyError(ex));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, []);

  const pendingId = charge?.status === "pending" ? charge.id : null;

  // The sale was cancelled, paid or replaced -> close any open fingerprint prompt.
  // (Declared before the effect below so a brand-new scan is never aborted by mistake.)
  useEffect(() => { abortRef.current?.abort(); setError(""); }, [pendingId]);

  // A new price arrives from the phone -> ask for a fingerprint right away.
  useEffect(() => {
    if (!on || !pendingId || busy || attempted.current.has(pendingId)) return;
    attempted.current.add(pendingId);
    scan(charge);
  }, [on, pendingId, busy, charge, scan]);
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!fingerprintSupported) {
    return <section className="panel"><p className="note fp-warn" style={{ margin: 0 }}>{unsupportedReason()}</p></section>;
  }

  if (!on) {
    return (
      <section className="panel terminal">
        <div className="fp-hero"><Icon name="fingerprint" size={72} /></div>
        <h2>Fingerprint terminal</h2>
        <p className="muted">Use this on the Mac with the fingerprint reader. Prices you pick on your phone show up here, and the customer approves with the fingerprint on their own phone.</p>
        <button className="btn primary" type="button" onClick={() => setOn(true)}>Start accepting payments</button>
      </section>
    );
  }

  const paidAgo = charge?.paid_at && serverTime ? Date.parse(serverTime) - Date.parse(charge.paid_at) : Infinity;
  const showPaid = charge?.status === "paid" && paidAgo < 15000;

  return (
    <section className={"panel terminal " + (showPaid ? "paid" : pendingId ? "pending" : "idle")}>
      {showPaid ? (
        <>
          <div className="fp-hero done"><Icon name="fingerprint" size={72} /></div>
          <div className="sale-amount">{money(charge.amount)}</div>
          <div className="sale-state ok">✓ Paid{charge.customer ? ` · ${charge.customer}` : ""}</div>
        </>
      ) : pendingId ? (
        <>
          <div className={"fp-hero" + (busy ? " scanning" : "")}><Icon name="fingerprint" size={72} /></div>
          <div className="sale-amount">{money(charge.amount)}</div>
          <div className="sale-label">{charge.label}</div>
          <div className="sale-state">{busy ? "Customer: approve with your fingerprint (phone prompt or QR)" : "Ready to scan"}</div>
          {!busy && <button className="btn primary" type="button" onClick={() => scan(charge)}>Scan fingerprint</button>}
        </>
      ) : (
        <>
          <div className="fp-hero"><Icon name="fingerprint" size={72} /></div>
          <div className="sale-state">Waiting for a price from the phone…</div>
        </>
      )}
      <p className="error" role="alert">{error}</p>
      <button className="btn ghost" type="button" onClick={() => setOn(false)}>Stop terminal</button>
    </section>
  );
}
