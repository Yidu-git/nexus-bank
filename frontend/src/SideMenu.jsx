import { useEffect, useRef } from "react";

const ICONS = {
  accounts: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /></>,
  move: <><path d="M7 7h12l-3-3M17 17H5l3 3" /></>,
  history: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  bluetooth: <path d="M7 7l10 10-5 5V2l5 5L7 17" />,
  fingerprint: <>
    <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
    <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
    <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
    <path d="M2 12a10 10 0 0 1 18-6" />
    <path d="M2 16h.01" />
    <path d="M21.8 16c.2-2 .131-5.354 0-6" />
    <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
    <path d="M8.65 22c.21-.66.45-1.32.57-2" />
    <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
  </>,
  business: <><path d="M3 9l1.5-5h15L21 9" /><path d="M4 9v11h16V9" /><path d="M3 9h18M9.5 20v-6h5v6" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" />,
  out: <path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9" />,
};

export function Icon({ name, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const ITEMS = [
  ["accounts", "Accounts"],
  ["move", "Move money"],
  ["history", "Transactions"],
  ["bluetooth", "Bluetooth Pay"],
  ["fingerprint", "Fingerprint Pay"],
  ["business", "Business"],
];

export default function SideMenu({ open, setOpen, view, onSelect, theme, onTheme, onLogout }) {
  const closeTimer = useRef(null);

  const openNow = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const closeSoon = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(closeTimer.current); };
  }, [setOpen]);

  return (
    <>
      {/* hot zone: hover (mouse) or tap (touch) the left edge to open */}
      {!open && (
        <div className="edge-zone" onMouseEnter={openNow} onClick={openNow}
          role="button" aria-label="Open menu"><i /></div>
      )}
      {open && <button className="side-backdrop" type="button" aria-label="Close menu" onClick={() => setOpen(false)} />}

      <aside className={"sidebar" + (open ? " open" : "")} aria-label="Main menu" aria-hidden={!open}
        onMouseEnter={openNow} onMouseLeave={closeSoon}>
        <div className="brand"><span className="logo">N</span> Nexus</div>

        <div className="side-label">What do you want to do?</div>
        {ITEMS.map(([id, label]) => (
          <button key={id} type="button" className={"nav-item" + (view === id ? " active" : "")}
            onClick={() => { onSelect(id); setOpen(false); }}>
            <Icon name={id} /> {label}
          </button>
        ))}

        <div className="side-spacer" />

        <div className="side-label">Appearance</div>
        <div className="theme-switch" role="group" aria-label="Color mode">
          <button type="button" className={theme === "dark" ? "active" : ""} onClick={() => onTheme("dark")}>
            <Icon name="moon" size={16} /> Dark
          </button>
          <button type="button" className={theme === "light" ? "active" : ""} onClick={() => onTheme("light")}>
            <Icon name="sun" size={16} /> Light
          </button>
        </div>

        <button type="button" className="nav-item" style={{ marginTop: 10 }} onClick={onLogout}>
          <Icon name="out" /> Sign out
        </button>
      </aside>
    </>
  );
}
