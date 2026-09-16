import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";

/* ================================================================
   Ledgerly — company accounting app with LOGIN + ROLES
================================================================ */

/* ---------------- helpers ---------------- */
let CUR = "USD";
const setCurrency = (c) => { CUR = c || "USD"; };
const fmt = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: CUR }).format(Number(n) || 0);
const uid = () => Math.random().toString(36).slice(2, 10);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
const addDays = (dateStr, days) => { const d = new Date(dateStr + "T12:00:00"); d.setDate(d.getDate() + days); return iso(d); };
const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000);
const monthLabel = (key) => new Date(key + "-01T12:00:00").toLocaleString("en-US", { month: "short" });
async function hashPassword(pw) {
  const data = new TextEncoder().encode("ledgerly::" + pw);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const docTotals = (doc) => {
  const subtotal = doc.lines.reduce((s, l) => s + (+l.qty || 0) * (+l.rate || 0), 0);
  const tax = subtotal * ((+doc.taxRate || 0) / 100);
  return { subtotal, tax, total: subtotal + tax };
};
const invStatus = (inv) => {
  if (inv.status === "paid") return "paid";
  if (inv.status === "draft") return "draft";
  return inv.dueDate < today() ? "overdue" : "sent";
};
const quoteStatus = (q) => (q.status === "sent" && q.expiryDate < today() ? "expired" : q.status);
const custName = (state, id) => (state.customers.find((c) => c.id === id) || {}).name || "Unknown customer";
const vendName = (state, id) => (state.vendors.find((v) => v.id === id) || {}).name || "—";
const nextDocNo = (list, prefix, start) => {
  const nums = list.map((d) => parseInt((d.number || "").replace(/\D/g, ""), 10)).filter((n) => !isNaN(n));
  return prefix + "-" + (nums.length ? Math.max(...nums) + 1 : start);
};
const nextInvoiceNo = (state) => nextDocNo(state.invoices, "INV", 1001);
const nextQuoteNo = (state) => nextDocNo(state.quotes, "QUO", 2001);
const nextReceiptNo = (state) => nextDocNo(state.receipts, "RCP", 1001);
function last6Months() {
  const out = []; const d = new Date(); d.setDate(1);
  for (let k = 5; k >= 0; k--) out.push(iso(new Date(d.getFullYear(), d.getMonth() - k, 1)).slice(0, 7));
  return out;
}
function nextFilingDeadline() {
  const n = new Date();
  return new Date(n.getFullYear(), Math.floor(n.getMonth() / 3) * 3 + 3, 0)
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function taxSummary(state) {
  const collected = state.invoices.filter((i) => i.status !== "draft").reduce((s, i) => s + docTotals(i).tax, 0);
  const itc = state.expenses.reduce((s, e) => s + Number(e.amount) * 0.1, 0);
  return { collected, itc, net: collected - itc };
}
function computeStats(state) {
  const t = today();
  const active = state.invoices.filter((i) => i.status !== "draft");
  const paidTotal = state.invoices.filter((i) => i.status === "paid").reduce((s, i) => s + docTotals(i).total, 0);
  const revenueAccrual = active.reduce((s, i) => s + docTotals(i).total, 0);
  const expenseTotal = state.expenses.reduce((s, e) => s + Number(e.amount), 0);
  const open = active.filter((i) => i.status !== "paid");
  const outstandingAmt = open.reduce((s, i) => s + docTotals(i).total, 0);
  const overdue = open.filter((i) => i.dueDate < t);
  const overdueAmt = overdue.reduce((s, i) => s + docTotals(i).total, 0);
  const chart = last6Months().map((k) => ({
    label: monthLabel(k),
    income: active.filter((i) => i.date.slice(0, 7) === k).reduce((s, i) => s + docTotals(i).total, 0),
    expense: state.expenses.filter((e) => e.date.slice(0, 7) === k).reduce((s, e) => s + Number(e.amount), 0),
  }));
  const catMap = {};
  state.expenses.forEach((e) => { catMap[e.category] = (catMap[e.category] || 0) + Number(e.amount); });
  const cats = Object.entries(catMap).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 6);
  return { paidTotal, revenueAccrual, expenseTotal, outstandingAmt, open, overdue, overdueAmt, cash: paidTotal - expenseTotal, profit: revenueAccrual - expenseTotal, chart, cats };
}
function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
function toCSV(rows) {
  if (!rows.length) return "";
  const heads = Object.keys(rows[0]);
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  return [heads.join(","), ...rows.map((r) => heads.map((h) => esc(r[h])).join(","))].join("\n");
}

/* ---------------- seed data ---------------- */
function seed() {
  const settings = {
    companyName: "Your Company",
    address: "",
    email: "",
    currency: "USD",
    taxRate: 8,
  };
  return { settings, customers: [], vendors: [], items: [], invoices: [], quotes: [], receipts: [], expenses: [], users: [], session: null };
}

/* ---------------- reducer ---------------- */
function reducer(state, action) {
  switch (action.type) {
    case "ADD_CUSTOMER": return { ...state, customers: [...state.customers, action.payload] };
    case "UPDATE_CUSTOMER": return { ...state, customers: state.customers.map((c) => (c.id === action.payload.id ? action.payload : c)) };
    case "DELETE_CUSTOMER": return { ...state, customers: state.customers.filter((c) => c.id !== action.id) };
    case "ADD_VENDOR": return { ...state, vendors: [...state.vendors, action.payload] };
    case "DELETE_VENDOR": return { ...state, vendors: state.vendors.filter((v) => v.id !== action.id) };
    case "ADD_ITEM": return { ...state, items: [...state.items, action.payload] };
    case "DELETE_ITEM": return { ...state, items: state.items.filter((i) => i.id !== action.id) };
    case "ADD_INVOICE": return { ...state, invoices: [...state.invoices, action.payload] };
    case "UPDATE_INVOICE": return { ...state, invoices: state.invoices.map((i) => (i.id === action.payload.id ? { ...i, ...action.payload } : i)) };
    case "DELETE_INVOICE": return { ...state, invoices: state.invoices.filter((i) => i.id !== action.id) };
    case "ADD_QUOTE": return { ...state, quotes: [...state.quotes, action.payload] };
    case "UPDATE_QUOTE": return { ...state, quotes: state.quotes.map((q) => (q.id === action.payload.id ? { ...q, ...action.payload } : q)) };
    case "DELETE_QUOTE": return { ...state, quotes: state.quotes.filter((q) => q.id !== action.id) };
    case "ADD_RECEIPT": return { ...state, receipts: [...state.receipts, action.payload] };
    case "ADD_EXPENSE": return { ...state, expenses: [...state.expenses, action.payload] };
    case "DELETE_EXPENSE": return { ...state, expenses: state.expenses.filter((e) => e.id !== action.id) };
    case "UPDATE_SETTINGS": return { ...state, settings: { ...state.settings, ...action.payload } };
    case "IMPORT_STATE": return action.payload;
    case "ADD_USER": return { ...state, users: [...state.users, action.payload] };
    case "UPDATE_USER": return { ...state, users: state.users.map((u) => (u.id === action.payload.id ? { ...u, ...action.payload } : u)) };
    case "DELETE_USER": return { ...state, users: state.users.filter((u) => u.id !== action.id), session: state.session === action.id ? null : state.session };
    case "SET_SESSION": return { ...state, session: action.payload };
    case "RESET": return seed();
    default: return state;
  }
}

const STORE_KEY = "ledgerly-v3";
const init = () => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      return {
        ...seed(),
        ...data,
        settings: { ...seed().settings, ...(data.settings || {}) },
        users: Array.isArray(data.users) ? data.users : [],
        session: data.session ?? null,
      };
    }
  } catch (e) { /* fall through to seed */ }
  return seed();
};

/* ---------------- icons ---------------- */
const PATHS = {
  home: <path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z" />,
  invoice: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></>,
  quote: <><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /><line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="13" y2="16" /></>,
  receipt: <><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="13" y2="16" /></>,
  card: <><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></>,
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  briefcase: <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></>,
  tag: <><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z" /><line x1="7" y1="7" x2="7.01" y2="7" /></>,
  book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>,
  chart: <><line x1="6" y1="20" x2="6" y2="14" /><line x1="12" y1="20" x2="12" y2="8" /><line x1="18" y1="20" x2="18" y2="4" /></>,
  percent: <><line x1="19" y1="5" x2="5" y2="19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
  sliders: <><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></>,
  search: <><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" /></>,
  plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  x: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
  trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" /></>,
  alert: <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
  arrowLeft: <><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>,
  arrowRight: <><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></>,
  check: <polyline points="20 6 9 17 4 12" />,
  printer: <><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>,
};
function Icon({ name, size = 17 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name]}
    </svg>
  );
}

/* ---------------- shared UI ---------------- */
const STATUS_META = {
  paid: ["b-paid", "Paid"], sent: ["b-sent", "Sent"], overdue: ["b-overdue", "Overdue"], draft: ["b-draft", "Draft"],
  accepted: ["b-accepted", "Accepted"], declined: ["b-declined", "Declined"], invoiced: ["b-invoiced", "Invoiced"], expired: ["b-expired", "Expired"],
};
const Badge = ({ status }) => { const [cls, label] = STATUS_META[status] || STATUS_META.draft; return <span className={`badge ${cls}`}>{label}</span>; };
const StatCard = ({ label, value, sub, subClass }) => (
  <div className="card stat">
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value}</div>
    {sub && <div className={`stat-sub ${subClass || ""}`}>{sub}</div>}
  </div>
);
function Modal({ title, children, onClose, width = 560 }) {
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: width }}>
        <div className="modal-head no-print">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
function BarChart({ data }) {
  const max = Math.max(...data.map((d) => Math.max(d.income, d.expense)), 1);
  return (
    <div>
      <div className="bar-chart">
        {data.map((d, i) => (
          <div className="bar-group" key={i}>
            <div className="bar-pair">
              <div className="bar income" style={{ height: `${(d.income / max) * 100}%` }} title={`Income ${fmt(d.income)}`} />
              <div className="bar expense" style={{ height: `${(d.expense / max) * 100}%` }} title={`Expenses ${fmt(d.expense)}`} />
            </div>
            <div className="bar-label">{d.label}</div>
          </div>
        ))}
      </div>
      <div className="legend" style={{ marginTop: 10, justifyContent: "center" }}>
        <span><span className="dot" style={{ background: "var(--green)" }} />Income</span>
        <span><span className="dot" style={{ background: "#c9d2dc" }} />Expenses</span>
      </div>
    </div>
  );
}
const DONUT_COLORS = ["#2ca01c", "#2f6fed", "#f5a623", "#e5484d", "#8e4ec6", "#12a594", "#e93d82", "#98a2b3"];
function Donut({ data, total }) {
  let acc = 0;
  const stops = data.map((d, i) => {
    const from = (acc / total) * 360; acc += d.value;
    return `${DONUT_COLORS[i % DONUT_COLORS.length]} ${from}deg ${(acc / total) * 360}deg`;
  }).join(", ");
  return (
    <div className="donut-wrap">
      <div className="donut" style={{ background: `conic-gradient(${stops})` }}>
        <div className="donut-center">
          <div>
            <div style={{ fontWeight: 750, fontSize: 15 }}>{fmt(total)}</div>
            <div className="muted" style={{ fontSize: 11 }}>total spent</div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {data.map((d, i) => (
          <div className="mini-row" key={d.name}>
            <span><span className="dot" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />{d.name}</span>
            <span style={{ fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{fmt(d.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
function LineItemsEditor({ state, lines, setLines }) {
  const setLine = (id, p) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)));
  const grid = { display: "grid", gridTemplateColumns: "1.7fr 70px 110px 100px 32px", gap: 8 };
  return (
    <div>
      <div style={{ ...grid, marginBottom: 4 }}>
        <span className="lbl" style={{ margin: 0 }}>Item / description</span>
        <span className="lbl right" style={{ margin: 0 }}>Qty</span>
        <span className="lbl right" style={{ margin: 0 }}>Rate</span>
        <span className="lbl right" style={{ margin: 0 }}>Amount</span>
        <span />
      </div>
      {lines.map((l) => (
        <div key={l.id} style={{ ...grid, marginBottom: 8, alignItems: "center" }}>
          <div>
            <select className="inp" style={{ marginBottom: 4 }} value={l.itemId}
              onChange={(e) => { const it = state.items.find((x) => x.id === e.target.value); setLine(l.id, { itemId: e.target.value, ...(it ? { description: it.name, rate: it.rate } : {}) }); }}>
              <option value="">Custom line…</option>
              {state.items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
            </select>
            <input className="inp" placeholder="Description" value={l.description} onChange={(e) => setLine(l.id, { description: e.target.value })} />
          </div>
          <input type="number" min="0" className="inp right" value={l.qty} onChange={(e) => setLine(l.id, { qty: e.target.value })} />
          <input type="number" min="0" step="0.01" className="inp right" value={l.rate} onChange={(e) => setLine(l.id, { rate: e.target.value })} />
          <div className="right" style={{ fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{fmt((+l.qty || 0) * (+l.rate || 0))}</div>
          <button className="icon-btn" title="Remove line" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}><Icon name="trash" size={15} /></button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={() => setLines((ls) => [...ls, { id: uid(), itemId: "", description: "", qty: 1, rate: 0 }])}><Icon name="plus" size={14} /> Add line</button>
    </div>
  );
}
function TotalsBox({ subtotal, taxAmt, label }) {
  return (
    <div style={{ background: "#fafbfc", border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px", alignSelf: "start" }}>
      <div className="mini-row"><span className="muted">Subtotal</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(subtotal)}</span></div>
      <div className="mini-row"><span className="muted">Tax</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(taxAmt)}</span></div>
      <div className="mini-row" style={{ fontWeight: 750 }}><span>{label || "Total"}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(subtotal + taxAmt)}</span></div>
    </div>
  );
}

/* ============== LOGIN / SETUP SCREEN ============== */
function AuthScreen({ dispatch }) {
  const [isSetup, setIsSetup] = useState(true);
  const [f, setF] = useState({ name: "", company: "", email: "", password: "", confirm: "" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const fail = (m) => { setErr(m); setBusy(false); };

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      if (isSetup) {
        if (!f.name.trim() || !f.email.trim()) return fail("Enter your name and email");
        if (f.password.length < 6) return fail("Password must be at least 6 characters");
        if (f.password !== f.confirm) return fail("Passwords don't match");
        const nextState = seed();
        const id = uid();
        nextState.users = [{ id, name: f.name.trim(), email: f.email.trim(), passwordHash: await hashPassword(f.password), role: "admin" }];
        nextState.session = id;
        if (f.company.trim()) nextState.settings.companyName = f.company.trim();
        dispatch({ type: "IMPORT_STATE", payload: nextState });
      } else {
        const email = f.email.trim().toLowerCase();
        const user = JSON.parse(localStorage.getItem(STORE_KEY) || "{}").users?.find((candidate) => candidate.email.toLowerCase() === email);
        if (!user || user.passwordHash !== await hashPassword(f.password)) return fail("Incorrect email or password.");
        dispatch({ type: "SET_SESSION", payload: user.id });
      }
    } catch (error) {
      fail("Unable to sign in. Please try again.");
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="brand-logo" style={{ width: 36, height: 36, fontSize: 17 }}>L</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Ledgerly</div>
            <div className="muted" style={{ fontSize: 10.5, letterSpacing: 1.2, textTransform: "uppercase" }}>Accounting</div>
          </div>
        </div>
        <h2 style={{ fontSize: 19, margin: "16px 0 4px" }}>{isSetup ? "Set up your workspace" : "Welcome back"}</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
          {isSetup ? "Create your secure local account and workspace." : "Sign in to your secure workspace."}
        </p>
        <div className="frm">
          {isSetup && (
            <>
              <div><label className="lbl">Company name</label><input className="inp" value={f.company} onChange={(e) => set("company", e.target.value)} placeholder="Your Company Ltd." /></div>
              <div><label className="lbl">Your name</label><input className="inp" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
            </>
          )}
          <div><label className="lbl">Email</label><input className="inp" type="email" autoComplete="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></div>
          <div><label className="lbl">Password</label><input className="inp" type="password" autoComplete={isSetup ? "new-password" : "current-password"} value={f.password} onChange={(e) => set("password", e.target.value)} /></div>
          {isSetup && <div><label className="lbl">Confirm password</label><input className="inp" type="password" value={f.confirm} onChange={(e) => set("confirm", e.target.value)} /></div>}
          {err && <div style={{ background: "#fdecea", color: "#c0262c", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, fontWeight: 600 }}>{err}</div>}
          <button className="btn btn-primary" style={{ justifyContent: "center", padding: "10px" }} disabled={busy}>
            {busy ? "Please wait…" : isSetup ? "Create admin account" : "Sign in"}
          </button>
          <button type="button" className="link" style={{ textAlign: "center" }} onClick={() => { setIsSetup((value) => !value); setErr(""); }}>
            {isSetup ? "Already have an account? Sign in" : "Need an account? Create one"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------------- printable documents ---------------- */
function DocPrint({ state, doc, kind, onClose }) {
  const st = state.settings;
  const c = state.customers.find((x) => x.id === doc.customerId);
  const t = docTotals(doc);
  const label = kind === "quote" ? "Quote" : "Invoice";
  const paid = kind === "invoice" && doc.status === "paid";
  return (
    <Modal title={`Print ${label.toLowerCase()} ${doc.number}`} width={720} onClose={onClose}>
      <div className="print-area">
        <div className="receipt">
          <div className="receipt-head">
            <div>
              <b style={{ fontSize: 16 }}>{st.companyName}</b>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{st.address}<br />{st.email}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase" }}>{label}</div>
              <div style={{ fontWeight: 650, marginTop: 2 }}>{doc.number}</div>
              <div className="muted" style={{ fontSize: 12 }}>{doc.date}</div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
            <div>
              <div className="lbl" style={{ margin: 0 }}>{kind === "quote" ? "Prepared for" : "Bill to"}</div>
              <div style={{ fontWeight: 650 }}>{c ? c.name : "Unknown customer"}</div>
              {c && c.email && <div className="muted" style={{ fontSize: 12 }}>{c.email}</div>}
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="lbl" style={{ margin: 0 }}>{kind === "quote" ? "Valid until" : "Due date"}</div>
              <div style={{ fontWeight: 650 }}>{kind === "quote" ? doc.expiryDate : doc.dueDate}</div>
              <div className="muted" style={{ fontSize: 12 }}>Tax {doc.taxRate || 0}%</div>
            </div>
          </div>
          <table className="tbl">
            <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={l.id}><td>{l.description}</td><td className="num">{l.qty}</td><td className="num">{fmt(l.rate)}</td><td className="num">{fmt(l.qty * l.rate)}</td></tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <div style={{ width: 250 }}>
              <div className="mini-row"><span className="muted">Subtotal</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.subtotal)}</span></div>
              <div className="mini-row"><span className="muted">Tax ({doc.taxRate || 0}%)</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.tax)}</span></div>
              <div className="mini-row" style={{ fontWeight: 750, fontSize: 15 }}><span>Total</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.total)}</span></div>
              {paid && <div className="mini-row" style={{ color: "var(--green-dark)", fontWeight: 650 }}><span>Paid {doc.paidDate} · {doc.paymentMethod || ""}</span><span>{fmt(t.total)}</span></div>}
            </div>
          </div>
          {doc.notes && <div className="muted" style={{ marginTop: 14, fontSize: 12 }}>Notes: {doc.notes}</div>}
          {paid && <div className="stamp">Paid</div>}
          <div className="muted" style={{ marginTop: 20, fontSize: 12, textAlign: "center" }}>Thank you for your business!</div>
        </div>
      </div>
      <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={() => window.print()}><Icon name="printer" size={15} /> Print / Save PDF</button>
      </div>
    </Modal>
  );
}
function ReceiptDetail({ state, receipt, onClose }) {
  const st = state.settings;
  const inv = state.invoices.find((i) => i.id === receipt.invoiceId);
  const c = state.customers.find((x) => x.id === receipt.customerId);
  const t = inv ? docTotals(inv) : { subtotal: receipt.amount, tax: 0, total: receipt.amount };
  return (
    <Modal title={`Receipt ${receipt.number}`} width={680} onClose={onClose}>
      <div className="print-area">
        <div className="receipt">
          <div className="receipt-head">
            <div>
              <b style={{ fontSize: 16 }}>{st.companyName}</b>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{st.address}<br />{st.email}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase" }}>Receipt</div>
              <div style={{ fontWeight: 650, marginTop: 2 }}>{receipt.number}</div>
              <div className="muted" style={{ fontSize: 12 }}>{receipt.date}</div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
            <div>
              <div className="lbl" style={{ margin: 0 }}>Received from</div>
              <div style={{ fontWeight: 650 }}>{c ? c.name : "Unknown customer"}</div>
              {c && c.email && <div className="muted" style={{ fontSize: 12 }}>{c.email}</div>}
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="lbl" style={{ margin: 0 }}>Payment</div>
              <div style={{ fontWeight: 650 }}>{receipt.method}</div>
              {inv && <div className="muted" style={{ fontSize: 12 }}>for {inv.number}</div>}
            </div>
          </div>
          {inv && (
            <table className="tbl">
              <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.id}><td>{l.description}</td><td className="num">{l.qty}</td><td className="num">{fmt(l.rate)}</td><td className="num">{fmt(l.qty * l.rate)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <div style={{ width: 240 }}>
              <div className="mini-row"><span className="muted">Subtotal</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.subtotal)}</span></div>
              <div className="mini-row"><span className="muted">Tax</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.tax)}</span></div>
              <div className="mini-row" style={{ fontWeight: 750, fontSize: 15 }}><span>Amount paid</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(receipt.amount)}</span></div>
            </div>
          </div>
          <div className="stamp">Paid</div>
          <div className="muted" style={{ marginTop: 18, fontSize: 12, textAlign: "center" }}>Thank you for your business!</div>
        </div>
      </div>
      <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={() => window.print()}><Icon name="printer" size={15} /> Print / Save PDF</button>
      </div>
    </Modal>
  );
}

/* ---------------- sidebar / topbar ---------------- */
const NAV = [
  { id: "dashboard", label: "Dashboard", icon: "home" },
  { id: "invoices", label: "Invoices", icon: "invoice" },
  { id: "quotes", label: "Quotes", icon: "quote" },
  { id: "receipts", label: "Receipts", icon: "receipt" },
  { id: "expenses", label: "Expenses", icon: "card" },
  { id: "customers", label: "Customers", icon: "users" },
  { id: "vendors", label: "Vendors", icon: "briefcase" },
  { id: "items", label: "Products & Services", icon: "tag" },
  { id: "accounts", label: "Chart of Accounts", icon: "book" },
  { id: "reports", label: "Reports", icon: "chart" },
  { id: "taxes", label: "Taxes", icon: "percent" },
  { id: "settings", label: "Settings", icon: "sliders" },
];
function Sidebar({ view, setView, me, company, onLogout, showSettings }) {
  const items = NAV.filter((n) => n.id !== "settings" || showSettings);
  const initials = me ? me.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase() : "??";
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">L</div>
        <div>
          <div className="brand-name">Ledgerly</div>
          <div className="brand-sub">Accounting</div>
        </div>
      </div>
      <nav className="nav">
        {items.map((n) => (
          <button key={n.id} className={`nav-item ${view === n.id ? "active" : ""}`} onClick={() => setView(n.id)}>
            <Icon name={n.icon} size={16} /> {n.label}
          </button>
        ))}
      </nav>
      <div className="side-foot">
        <div className="avatar">{initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "#fff", fontSize: 13, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{me?.name}</div>
          <div style={{ fontSize: 11, color: "#8ea0ad", textTransform: "capitalize" }}>{me?.role} · {company}</div>
        </div>
        <button className="icon-btn" title="Sign out" style={{ color: "#8ea0ad" }} onClick={onLogout}>
          <Icon name="logout" size={15} />
        </button>
      </div>
    </aside>
  );
}
function TopBar({ view, state, setView, openModal, openInvoice, openQuote, canEdit }) {
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState(false);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const out = [];
    state.customers.forEach((c) => { if ((c.name + " " + (c.email || "")).toLowerCase().includes(s)) out.push({ type: "Customer", label: c.name, go: () => setView("customers") }); });
    state.invoices.forEach((i) => { const cn = custName(state, i.customerId); if ((i.number + " " + cn).toLowerCase().includes(s)) out.push({ type: "Invoice", label: `${i.number} · ${cn}`, go: () => openInvoice(i.id) }); });
    state.quotes.forEach((qt) => { const cn = custName(state, qt.customerId); if ((qt.number + " " + cn).toLowerCase().includes(s)) out.push({ type: "Quote", label: `${qt.number} · ${cn}`, go: () => openQuote(qt.id) }); });
    state.vendors.forEach((v) => { if (v.name.toLowerCase().includes(s)) out.push({ type: "Vendor", label: v.name, go: () => setView("vendors") }); });
    state.expenses.forEach((e) => { if ((e.description || "").toLowerCase().includes(s)) out.push({ type: "Expense", label: `${e.description} · ${fmt(e.amount)}`, go: () => setView("expenses") }); });
    return out.slice(0, 8);
  }, [q, state, setView, openInvoice, openQuote]);
  const title = (NAV.find((n) => n.id === view) || {}).label || "";
  return (
    <div className="topbar">
      <div style={{ fontWeight: 700, fontSize: 15, minWidth: 150 }}>{title}</div>
      <div className="search">
        <Icon name="search" size={15} />
        <input placeholder="Search invoices, quotes, customers…" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setTimeout(() => setQ(""), 150)} />
        {q.length >= 2 && results.length > 0 && (
          <div className="search-pop">
            {results.map((r, i) => (
              <div key={i} className="search-item" onMouseDown={() => { r.go(); setQ(""); }}>
                <span>{r.label}</span><span className="search-tag">{r.type}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {canEdit && (
        <div style={{ marginLeft: "auto", position: "relative" }}>
          <button className="btn btn-primary" onClick={() => setMenu((m) => !m)}><Icon name="plus" size={15} /> New</button>
          {menu && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 55 }} onClick={() => setMenu(false)} />
              <div className="menu-pop">
                <button className="menu-item" onClick={() => { openModal({ type: "invoice" }); setMenu(false); }}><Icon name="invoice" size={15} /> Invoice</button>
                <button className="menu-item" onClick={() => { openModal({ type: "quote" }); setMenu(false); }}><Icon name="quote" size={15} /> Quote</button>
                <button className="menu-item" onClick={() => { openModal({ type: "expense" }); setMenu(false); }}><Icon name="card" size={15} /> Expense</button>
                <button className="menu-item" onClick={() => { openModal({ type: "customer" }); setMenu(false); }}><Icon name="users" size={15} /> Customer</button>
                <button className="menu-item" onClick={() => { openModal({ type: "vendor" }); setMenu(false); }}><Icon name="briefcase" size={15} /> Vendor</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- dashboard ---------------- */
function Dashboard({ state, setView, openInvoice }) {
  const s = useMemo(() => computeStats(state), [state]);
  const t = today();
  const recent = useMemo(() => {
    const rows = [];
    state.invoices.forEach((i) => {
      if (i.status === "paid") rows.push({ date: i.paidDate || i.date, label: `Payment received · ${i.number}`, amount: docTotals(i).total, kind: "in" });
      else if (i.status !== "draft") rows.push({ date: i.date, label: `Invoice sent · ${i.number}`, amount: docTotals(i).total, kind: "pending" });
    });
    state.quotes.forEach((qt) => {
      if (qt.status !== "draft") rows.push({ date: qt.date, label: `Quote ${qt.status === "invoiced" ? "converted" : qt.status === "accepted" ? "accepted" : "sent"} · ${qt.number}`, amount: docTotals(qt).total, kind: "pending" });
    });
    state.expenses.forEach((e) => rows.push({ date: e.date, label: `${e.description} · ${vendName(state, e.vendorId)}`, amount: Number(e.amount), kind: "out" }));
    return rows.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 7);
  }, [state]);
  const openQuotes = state.quotes.filter((qt) => quoteStatus(qt) === "sent" || quoteStatus(qt) === "accepted").length;
  return (
    <div>
      {s.overdue.length > 0 && (
        <div className="banner">
          <Icon name="alert" size={16} />
          <span><b>{s.overdue.length} invoice{s.overdue.length > 1 ? "s" : ""} overdue</b> — {fmt(s.overdueAmt)} past due date.</span>
          <button className="link" style={{ marginLeft: "auto" }} onClick={() => setView("invoices")}>Review now</button>
        </div>
      )}
      <div className="grid grid-4">
        <StatCard label="Cash on hand" value={fmt(s.cash)} sub="Payments received − expenses paid" subClass={s.cash < 0 ? "neg" : "pos"} />
        <StatCard label="Net profit" value={fmt(s.profit)} sub={`on ${fmt(s.revenueAccrual)} invoiced (accrual)`} subClass={s.profit >= 0 ? "pos" : "neg"} />
        <StatCard label="Outstanding receivables" value={fmt(s.outstandingAmt)} sub={`${s.open.length} open invoice${s.open.length === 1 ? "" : "s"}`} />
        <StatCard label="Open quotes" value={String(openQuotes)} sub={`${fmt(s.expenseTotal)} expenses all-time`} />
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card card-pad">
          <div className="card-title">Cash flow — last 6 months</div>
          <BarChart data={s.chart} />
        </div>
        <div className="card card-pad">
          <div className="card-title">Spending by category</div>
          {s.cats.length ? <Donut data={s.cats} total={s.expenseTotal} /> : <div className="empty">No expenses yet.</div>}
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 16 }}>
        <div className="card card-pad">
          <div className="card-title">Unpaid invoices <button className="link" onClick={() => setView("invoices")}>View all</button></div>
          {s.open.length === 0 && <div className="empty">Nothing outstanding. 🎉</div>}
          {s.open.slice(0, 5).map((i) => {
            const past = daysBetween(i.dueDate, t);
            return (
              <div className="mini-row clickable" key={i.id} onClick={() => openInvoice(i.id)}>
                <span>
                  <b>{i.number}</b> <span className="muted">· {custName(state, i.customerId)}</span>
                  {past > 0 && <span className="pill" style={{ marginLeft: 8, background: "#fdecea", color: "#c0262c" }}>{past}d late</span>}
                </span>
                <span style={{ fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{fmt(docTotals(i).total)}</span>
              </div>
            );
          })}
        </div>
        <div className="card card-pad">
          <div className="card-title">Recent activity</div>
          {recent.map((r, i) => (
            <div className="mini-row" key={i}>
              <span><span className="muted" style={{ marginRight: 8 }}>{r.date.slice(5)}</span>{r.label}</span>
              <span style={{ fontWeight: 650, fontVariantNumeric: "tabular-nums", color: r.kind === "in" ? "var(--green-dark)" : r.kind === "out" ? "var(--red)" : "var(--ink)" }}>
                {r.kind === "out" ? "−" : ""}{fmt(r.amount)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- invoices ---------------- */
function PaymentModal({ state, inv, onClose, dispatch, notify }) {
  const t = docTotals(inv);
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState("Bank transfer");
  const receiptNo = nextReceiptNo(state);
  const confirm = () => {
    dispatch({ type: "UPDATE_INVOICE", payload: { id: inv.id, status: "paid", paidDate: date, paymentMethod: method } });
    dispatch({ type: "ADD_RECEIPT", payload: { id: uid(), number: receiptNo, invoiceId: inv.id, customerId: inv.customerId, date, method, amount: t.total } });
    notify(`Payment recorded — receipt ${receiptNo} issued`);
    onClose();
  };
  return (
    <Modal title="Record payment" width={460} onClose={onClose}>
      <div className="frm">
        <div style={{ background: "#f4f8f3", border: "1px solid #d8ecd4", borderRadius: 10, padding: "12px 14px", display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 650 }}>{inv.number} · {custName(state, inv.customerId)}</span>
          <span style={{ fontWeight: 750, fontVariantNumeric: "tabular-nums" }}>{fmt(t.total)}</span>
        </div>
        <div className="frm-row">
          <div><label className="lbl">Payment date</label><input type="date" className="inp" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div>
            <label className="lbl">Method</label>
            <select className="inp" value={method} onChange={(e) => setMethod(e.target.value)}>
              {["Bank transfer", "Credit card", "Cash", "Check"].map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>Receipt {receiptNo} will be issued automatically.</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={confirm}><Icon name="check" size={15} /> Record payment</button>
        </div>
      </div>
    </Modal>
  );
}

function InvoiceDetail({ state, dispatch, inv, onBack, notify, canEdit }) {
  const [payOpen, setPayOpen] = useState(false);
  const [rcptSel, setRcptSel] = useState(null);
  const [printOpen, setPrintOpen] = useState(false);
  const c = state.customers.find((x) => x.id === inv.customerId);
  const fromQuote = inv.quoteId ? state.quotes.find((q) => q.id === inv.quoteId) : null;
  const receipt = state.receipts.find((r) => r.invoiceId === inv.id);
  const t = docTotals(inv);
  const status = invStatus(inv);
  const patch = (p, msg) => { dispatch({ type: "UPDATE_INVOICE", payload: { id: inv.id, ...p } }); notify(msg); };
  return (
    <div>
      <button className="link" onClick={onBack}><Icon name="arrowLeft" size={14} style={{ verticalAlign: "-2px" }} /> Back to invoices</button>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-pad">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 20, fontWeight: 750 }}>{inv.number}</span>
                <Badge status={status} />
                {fromQuote && <span className="pill">from {fromQuote.number}</span>}
              </div>
              <div style={{ marginTop: 4, fontWeight: 650 }}>{c ? c.name : "Unknown customer"}</div>
              {c && <div className="muted" style={{ fontSize: 12 }}>{c.email}</div>}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <button className="btn btn-ghost" onClick={() => setPrintOpen(true)}><Icon name="printer" size={15} /> Print</button>
              {canEdit && status === "draft" && <button className="btn btn-ghost" onClick={() => patch({ status: "sent" }, "Invoice marked as sent")}>Mark as sent</button>}
              {canEdit && (status === "sent" || status === "overdue") && (
                <button className="btn btn-primary" onClick={() => setPayOpen(true)}><Icon name="check" size={15} /> Record payment</button>
              )}
              {status === "paid" && receipt && (
                <button className="btn btn-ghost" onClick={() => setRcptSel(receipt)}><Icon name="receipt" size={15} /> View receipt</button>
              )}
              {canEdit && (
                <button className="btn btn-danger" onClick={() => { if (window.confirm(`Delete ${inv.number}?`)) { dispatch({ type: "DELETE_INVOICE", id: inv.id }); onBack(); notify("Invoice deleted"); } }}>
                  <Icon name="trash" size={14} /> Delete
                </button>
              )}
            </div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginTop: 18, maxWidth: 720 }}>
            <div><div className="lbl" style={{ margin: 0 }}>Invoice date</div><div style={{ fontWeight: 600 }}>{inv.date}</div></div>
            <div><div className="lbl" style={{ margin: 0 }}>Due date</div><div style={{ fontWeight: 600 }}>{inv.dueDate}</div></div>
            <div><div className="lbl" style={{ margin: 0 }}>Payment date</div><div style={{ fontWeight: 600 }}>{inv.paidDate || "—"}</div></div>
            <div><div className="lbl" style={{ margin: 0 }}>Method</div><div style={{ fontWeight: 600 }}>{inv.paymentMethod || "—"}</div></div>
          </div>
          <div className="tbl-wrap" style={{ marginTop: 20 }}>
            <table className="tbl">
              <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.id}><td>{l.description}</td><td className="num">{l.qty}</td><td className="num">{fmt(l.rate)}</td><td className="num" style={{ fontWeight: 650 }}>{fmt(l.qty * l.rate)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <div style={{ width: 260 }}>
              <div className="mini-row"><span className="muted">Subtotal</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.subtotal)}</span></div>
              <div className="mini-row"><span className="muted">Tax ({inv.taxRate || 0}%)</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.tax)}</span></div>
              <div className="mini-row" style={{ fontWeight: 750, fontSize: 15 }}><span>Total</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.total)}</span></div>
              {status !== "paid" && status !== "draft" && (
                <div className="mini-row" style={{ color: "var(--red)", fontWeight: 650 }}><span>Balance due</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.total)}</span></div>
              )}
            </div>
          </div>
          {inv.notes && <div className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>Notes: {inv.notes}</div>}
        </div>
      </div>
      {payOpen && <PaymentModal state={state} inv={inv} onClose={() => setPayOpen(false)} dispatch={dispatch} notify={notify} />}
      {rcptSel && <ReceiptDetail state={state} receipt={rcptSel} onClose={() => setRcptSel(null)} />}
      {printOpen && <DocPrint state={state} doc={inv} kind="invoice" onClose={() => setPrintOpen(false)} />}
    </div>
  );
}

function Invoices({ state, dispatch, openModal, notify, openId, setOpenId, canEdit }) {
  const [filter, setFilter] = useState("all");
  const counts = useMemo(() => {
    const c = { all: state.invoices.length, draft: 0, sent: 0, overdue: 0, paid: 0 };
    state.invoices.forEach((i) => { c[invStatus(i)]++; });
    return c;
  }, [state]);
  const rows = useMemo(() => {
    return state.invoices
      .filter((i) => filter === "all" || invStatus(i) === filter)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.number < b.number ? 1 : -1));
  }, [state, filter]);
  const sel = openId ? state.invoices.find((i) => i.id === openId) : null;
  if (sel) return <InvoiceDetail state={state} dispatch={dispatch} inv={sel} onBack={() => setOpenId(null)} notify={notify} canEdit={canEdit} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">Invoices</div>
          <div className="page-sub">{state.invoices.length} total · {fmt(state.invoices.filter((i) => invStatus(i) === "overdue").reduce((s, i) => s + docTotals(i).total, 0))} overdue</div>
        </div>
        {canEdit && <button className="btn btn-primary" onClick={() => openModal({ type: "invoice" })}><Icon name="plus" size={15} /> New invoice</button>}
      </div>
      <div className="filters" style={{ marginBottom: 14 }}>
        {["all", "draft", "sent", "overdue", "paid"].map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)} ({counts[f]})
          </button>
        ))}
      </div>
      <div className="card tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Due</th><th>Status</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="7"><div className="empty">No invoices match this filter.</div></td></tr>}
            {rows.map((i) => {
              const t = docTotals(i);
              const st = invStatus(i);
              return (
                <tr key={i.id} className="clickable" onClick={() => setOpenId(i.id)}>
                  <td style={{ fontWeight: 650 }}>{i.number}</td>
                  <td>{custName(state, i.customerId)}</td>
                  <td className="muted">{i.date}</td>
                  <td className="muted">{i.dueDate}</td>
                  <td><Badge status={st} /></td>
                  <td className="num">{fmt(t.total)}</td>
                  <td className="num" style={{ fontWeight: 650 }}>{st === "paid" ? fmt(0) : fmt(t.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvoiceForm({ state, dispatch, onClose, notify }) {
  const [number] = useState(() => nextInvoiceNo(state));
  const [customerId, setCustomerId] = useState(state.customers[0] ? state.customers[0].id : "");
  const [date, setDate] = useState(today());
  const [dueDate, setDueDate] = useState(addDays(today(), 30));
  const [taxRate, setTaxRate] = useState(state.settings.taxRate ?? 8);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ id: uid(), itemId: "", description: "", qty: 1, rate: 175 }]);
  const subtotal = lines.reduce((s, l) => s + (+l.qty || 0) * (+l.rate || 0), 0);
  const taxAmt = subtotal * ((+taxRate || 0) / 100);
  const save = (status) => {
    if (!customerId) return notify("Choose a customer first");
    const clean = lines.filter((l) => l.description.trim() && +l.rate > 0 && +l.qty > 0);
    if (!clean.length) return notify("Add at least one line item");
    dispatch({ type: "ADD_INVOICE", payload: { id: uid(), number, customerId, date, dueDate, taxRate: +taxRate || 0, notes, status, lines: clean } });
    notify(status === "sent" ? `Invoice ${number} sent` : `Invoice ${number} saved as draft`);
    onClose();
  };
  return (
    <div className="frm">
      <div className="frm-row">
        <div>
          <label className="lbl">Customer</label>
          <select className="inp" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Select customer…</option>
            {state.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><label className="lbl">Invoice no.</label><input className="inp" value={number} readOnly /></div>
          <div><label className="lbl">Tax rate %</label><input type="number" min="0" className="inp" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} /></div>
        </div>
      </div>
      <div className="frm-row">
        <div><label className="lbl">Invoice date</label><input type="date" className="inp" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className="lbl">Due date</label><input type="date" className="inp" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
      </div>
      <div><label className="lbl">Line items</label><LineItemsEditor state={state} lines={lines} setLines={setLines} /></div>
      <div className="frm-row" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <div><label className="lbl">Notes</label><textarea className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Payment terms, thank-you note…" /></div>
        <TotalsBox subtotal={subtotal} taxAmt={taxAmt} />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-ghost" onClick={() => save("draft")}>Save draft</button>
        <button className="btn btn-primary" onClick={() => save("sent")}>Save &amp; send</button>
      </div>
    </div>
  );
}

/* ---------------- quotes ---------------- */
function QuoteDetail({ state, dispatch, quote: q, onBack, notify, openInvoice, canEdit }) {
  const [printOpen, setPrintOpen] = useState(false);
  const c = state.customers.find((x) => x.id === q.customerId);
  const linkedInv = state.invoices.find((i) => i.quoteId === q.id);
  const t = docTotals(q);
  const st = quoteStatus(q);
  const patch = (p, msg) => { dispatch({ type: "UPDATE_QUOTE", payload: { id: q.id, ...p } }); notify(msg); };
  const convert = () => {
    const invId = uid();
    const num = nextInvoiceNo(state);
    dispatch({
      type: "ADD_INVOICE",
      payload: { id: invId, number: num, customerId: q.customerId, date: today(), dueDate: addDays(today(), 30), taxRate: q.taxRate, notes: q.notes, status: "sent", quoteId: q.id, lines: q.lines.map((l) => ({ ...l, id: uid() })) },
    });
    dispatch({ type: "UPDATE_QUOTE", payload: { id: q.id, status: "invoiced" } });
    notify(`Quote converted — invoice ${num} created`);
    onBack();
    openInvoice(invId);
  };
  return (
    <div>
      <button className="link" onClick={onBack}><Icon name="arrowLeft" size={14} style={{ verticalAlign: "-2px" }} /> Back to quotes</button>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-pad">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 20, fontWeight: 750 }}>{q.number}</span>
                <Badge status={st} />
              </div>
              <div style={{ marginTop: 4, fontWeight: 650 }}>{c ? c.name : "Unknown customer"}</div>
              {c && <div className="muted" style={{ fontSize: 12 }}>{c.email}</div>}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <button className="btn btn-ghost" onClick={() => setPrintOpen(true)}><Icon name="printer" size={15} /> Print</button>
              {canEdit && st === "draft" && <button className="btn btn-ghost" onClick={() => patch({ status: "sent" }, "Quote marked as sent")}>Mark as sent</button>}
              {canEdit && (st === "sent" || st === "expired") && (
                <>
                  <button className="btn btn-primary" onClick={() => patch({ status: "accepted" }, "Quote accepted")}>Mark accepted</button>
                  <button className="btn btn-ghost" onClick={() => patch({ status: "declined" }, "Quote declined")}>Decline</button>
                </>
              )}
              {canEdit && (st === "draft" || st === "sent" || st === "expired" || st === "accepted") && (
                <button className={st === "accepted" ? "btn btn-primary" : "btn btn-ghost"} onClick={convert}>
                  <Icon name="arrowRight" size={15} /> Convert to invoice
                </button>
              )}
              {linkedInv && <button className="btn btn-ghost" onClick={() => { onBack(); openInvoice(linkedInv.id); }}>View {linkedInv.number}</button>}
              {canEdit && (
                <button className="btn btn-danger" onClick={() => { if (window.confirm(`Delete ${q.number}?`)) { dispatch({ type: "DELETE_QUOTE", id: q.id }); onBack(); notify("Quote deleted"); } }}>
                  <Icon name="trash" size={14} /> Delete
                </button>
              )}
            </div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", marginTop: 18, maxWidth: 560 }}>
            <div><div className="lbl" style={{ margin: 0 }}>Quote date</div><div style={{ fontWeight: 600 }}>{q.date}</div></div>
            <div><div className="lbl" style={{ margin: 0 }}>Valid until</div><div style={{ fontWeight: 600 }}>{q.expiryDate}</div></div>
            <div><div className="lbl" style={{ margin: 0 }}>Tax rate</div><div style={{ fontWeight: 600 }}>{q.taxRate || 0}%</div></div>
          </div>
          <div className="tbl-wrap" style={{ marginTop: 20 }}>
            <table className="tbl">
              <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {q.lines.map((l) => (
                  <tr key={l.id}><td>{l.description}</td><td className="num">{l.qty}</td><td className="num">{fmt(l.rate)}</td><td className="num" style={{ fontWeight: 650 }}>{fmt(l.qty * l.rate)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <div style={{ width: 260 }}>
              <div className="mini-row"><span className="muted">Subtotal</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.subtotal)}</span></div>
              <div className="mini-row"><span className="muted">Tax ({q.taxRate || 0}%)</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.tax)}</span></div>
              <div className="mini-row" style={{ fontWeight: 750, fontSize: 15 }}><span>Quote total</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(t.total)}</span></div>
            </div>
          </div>
          {q.notes && <div className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>Notes: {q.notes}</div>}
        </div>
      </div>
      {printOpen && <DocPrint state={state} doc={q} kind="quote" onClose={() => setPrintOpen(false)} />}
    </div>
  );
}

function Quotes({ state, dispatch, openModal, notify, openId, setOpenId, openInvoice, canEdit }) {
  const [filter, setFilter] = useState("all");
  const counts = useMemo(() => {
    const c = { all: state.quotes.length, draft: 0, sent: 0, expired: 0, accepted: 0, declined: 0, invoiced: 0 };
    state.quotes.forEach((q) => { c[quoteStatus(q)]++; });
    return c;
  }, [state]);
  const rows = useMemo(() => state.quotes.filter((q) => filter === "all" || quoteStatus(q) === filter).sort((a, b) => (a.date < b.date ? 1 : -1)), [state, filter]);
  const sel = openId ? state.quotes.find((q) => q.id === openId) : null;
  if (sel) return <QuoteDetail state={state} dispatch={dispatch} quote={sel} onBack={() => setOpenId(null)} notify={notify} openInvoice={openInvoice} canEdit={canEdit} />;
  const pipeline = state.quotes.filter((q) => quoteStatus(q) === "sent" || quoteStatus(q) === "accepted").reduce((s, q) => s + docTotals(q).total, 0);
  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">Quotes</div>
          <div className="page-sub">{fmt(pipeline)} in your sales pipeline</div>
        </div>
        {canEdit && <button className="btn btn-primary" onClick={() => openModal({ type: "quote" })}><Icon name="plus" size={15} /> New quote</button>}
      </div>
      <div className="filters" style={{ marginBottom: 14 }}>
        {["all", "draft", "sent", "expired", "accepted", "declined", "invoiced"].map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)} ({counts[f]})
          </button>
        ))}
      </div>
      <div className="card tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Quote</th><th>Customer</th><th>Date</th><th>Valid until</th><th>Status</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="6"><div className="empty">No quotes match this filter.</div></td></tr>}
            {rows.map((q) => (
              <tr key={q.id} className="clickable" onClick={() => setOpenId(q.id)}>
                <td style={{ fontWeight: 650 }}>{q.number}</td>
                <td>{custName(state, q.customerId)}</td>
                <td className="muted">{q.date}</td>
                <td className="muted">{q.expiryDate}</td>
                <td><Badge status={quoteStatus(q)} /></td>
                <td className="num" style={{ fontWeight: 650 }}>{fmt(docTotals(q).total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QuoteForm({ state, dispatch, onClose, notify }) {
  const [number] = useState(() => nextQuoteNo(state));
  const [customerId, setCustomerId] = useState(state.customers[0] ? state.customers[0].id : "");
  const [date, setDate] = useState(today());
  const [expiryDate, setExpiryDate] = useState(addDays(today(), 21));
  const [taxRate, setTaxRate] = useState(state.settings.taxRate ?? 8);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ id: uid(), itemId: "", description: "", qty: 1, rate: 175 }]);
  const subtotal = lines.reduce((s, l) => s + (+l.qty || 0) * (+l.rate || 0), 0);
  const taxAmt = subtotal * ((+taxRate || 0) / 100);
  const save = (status) => {
    if (!customerId) return notify("Choose a customer first");
    const clean = lines.filter((l) => l.description.trim() && +l.rate > 0 && +l.qty > 0);
    if (!clean.length) return notify("Add at least one line item");
    dispatch({ type: "ADD_QUOTE", payload: { id: uid(), number, customerId, date, expiryDate, taxRate: +taxRate || 0, notes, status, lines: clean } });
    notify(status === "sent" ? `Quote ${number} sent` : `Quote ${number} saved as draft`);
    onClose();
  };
  return (
    <div className="frm">
      <div className="frm-row">
        <div>
          <label className="lbl">Customer</label>
          <select className="inp" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Select customer…</option>
            {state.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><label className="lbl">Quote no.</label><input className="inp" value={number} readOnly /></div>
          <div><label className="lbl">Tax rate %</label><input type="number" min="0" className="inp" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} /></div>
        </div>
      </div>
      <div className="frm-row">
        <div><label className="lbl">Quote date</label><input type="date" className="inp" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className="lbl">Valid until</label><input type="date" className="inp" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></div>
      </div>
      <div><label className="lbl">Line items</label><LineItemsEditor state={state} lines={lines} setLines={setLines} /></div>
      <div className="frm-row" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <div><label className="lbl">Notes</label><textarea className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Terms, delivery timeline…" /></div>
        <TotalsBox subtotal={subtotal} taxAmt={taxAmt} label="Quote total" />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-ghost" onClick={() => save("draft")}>Save draft</button>
        <button className="btn btn-primary" onClick={() => save("sent")}>Save &amp; send</button>
      </div>
    </div>
  );
}

/* ---------------- receipts list ---------------- */
function Receipts({ state }) {
  const [selId, setSelId] = useState(null);
  const rows = useMemo(() => [...state.receipts].sort((a, b) => (a.date < b.date ? 1 : -1)), [state]);
  const total = state.receipts.reduce((s, r) => s + Number(r.amount), 0);
  const curKey = today().slice(0, 7);
  const thisMonth = state.receipts.filter((r) => r.date.slice(0, 7) === curKey).reduce((s, r) => s + Number(r.amount), 0);
  const sel = selId ? state.receipts.find((r) => r.id === selId) : null;
  return (
    <div>
      <div className="page-head">
        <div><div className="page-title">Receipts</div><div className="page-sub">Issued automatically when an invoice is paid</div></div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 16 }}>
        <StatCard label="Total received" value={fmt(total)} sub={`${state.receipts.length} receipts issued`} />
        <StatCard label="Received this month" value={fmt(thisMonth)} />
        <StatCard label="Average receipt" value={state.receipts.length ? fmt(total / state.receipts.length) : fmt(0)} />
      </div>
      <div className="card tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Receipt</th><th>Date</th><th>Customer</th><th>Invoice</th><th>Method</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="6"><div className="empty">No receipts yet — record a payment on an invoice to issue one.</div></td></tr>}
            {rows.map((r) => {
              const inv = state.invoices.find((i) => i.id === r.invoiceId);
              return (
                <tr key={r.id} className="clickable" onClick={() => setSelId(r.id)}>
                  <td style={{ fontWeight: 650 }}>{r.number}</td>
                  <td className="muted">{r.date}</td>
                  <td>{custName(state, r.customerId)}</td>
                  <td>{inv ? inv.number : "—"}</td>
                  <td><span className="pill">{r.method}</span></td>
                  <td className="num" style={{ fontWeight: 650 }}>{fmt(r.amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sel && <ReceiptDetail state={state} receipt={sel} onClose={() => setSelId(null)} />}
    </div>
  );
}

/* ---------------- expenses ---------------- */
const EXPENSE_CATS = ["Rent", "Software", "Marketing", "Office Supplies", "Travel", "Utilities", "Insurance", "Professional Fees", "Other"];
function Expenses({ state, dispatch, openModal, notify, canEdit }) {
  const stats = useMemo(() => {
    const curKey = today().slice(0, 7);
    const pd = new Date(); pd.setMonth(pd.getMonth() - 1);
    const prevKey = iso(pd).slice(0, 7);
    const cur = state.expenses.filter((e) => e.date.slice(0, 7) === curKey).reduce((s, e) => s + Number(e.amount), 0);
    const prev = state.expenses.filter((e) => e.date.slice(0, 7) === prevKey).reduce((s, e) => s + Number(e.amount), 0);
    const catMap = {};
    state.expenses.forEach((e) => { catMap[e.category] = (catMap[e.category] || 0) + Number(e.amount); });
    const top = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];
    return { cur, prev, top };
  }, [state]);
  const rows = useMemo(() => [...state.expenses].sort((a, b) => (a.date < b.date ? 1 : -1)), [state]);
  return (
    <div>
      <div className="page-head">
        <div><div className="page-title">Expenses</div><div className="page-sub">Track every dollar going out</div></div>
        {canEdit && <button className="btn btn-primary" onClick={() => openModal({ type: "expense" })}><Icon name="plus" size={15} /> New expense</button>}
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 16 }}>
        <StatCard label="This month" value={fmt(stats.cur)} />
        <StatCard label="Last month" value={fmt(stats.prev)} />
        <StatCard label="Top category" value={stats.top ? stats.top[0] : "—"} sub={stats.top ? fmt(stats.top[1]) + " all-time" : ""} />
      </div>
      <div className="card tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Description</th><th>Method</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="muted">{e.date}</td>
                <td>{vendName(state, e.vendorId)}</td>
                <td><span className="pill">{e.category}</span></td>
                <td>{e.description}</td>
                <td className="muted">{e.paymentMethod}</td>
                <td className="num" style={{ fontWeight: 650 }}>{fmt(e.amount)}</td>
                <td className="num">
                  {canEdit && (
                    <button className="icon-btn" title="Delete" onClick={() => { if (window.confirm("Delete this expense?")) { dispatch({ type: "DELETE_EXPENSE", id: e.id }); notify("Expense deleted"); } }}>
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function ExpenseForm({ state, dispatch, onClose, notify }) {
  const [f, setF] = useState({ date: today(), vendorId: "", category: "Software", description: "", amount: "", paymentMethod: "Credit card" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = () => {
    if (!f.description.trim()) return notify("Enter a description");
    if (!(+f.amount > 0)) return notify("Enter a valid amount");
    dispatch({ type: "ADD_EXPENSE", payload: { ...f, id: uid(), amount: +f.amount } });
    notify("Expense recorded"); onClose();
  };
  return (
    <div className="frm">
      <div className="frm-row">
        <div><label className="lbl">Date</label><input type="date" className="inp" value={f.date} onChange={(e) => set("date", e.target.value)} /></div>
        <div>
          <label className="lbl">Vendor</label>
          <select className="inp" value={f.vendorId} onChange={(e) => set("vendorId", e.target.value)}>
            <option value="">— None —</option>
            {state.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
      </div>
      <div className="frm-row">
        <div>
          <label className="lbl">Category</label>
          <select className="inp" value={f.category} onChange={(e) => set("category", e.target.value)}>
            {EXPENSE_CATS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="lbl">Payment method</label>
          <select className="inp" value={f.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)}>
            {["Bank transfer", "Credit card", "Cash", "Check"].map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
      </div>
      <div><label className="lbl">Description</label><input className="inp" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Cloud infrastructure" /></div>
      <div><label className="lbl">Amount</label><input type="number" min="0" step="0.01" className="inp" value={f.amount} onChange={(e) => set("amount", e.target.value)} placeholder="0.00" /></div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save expense</button>
      </div>
    </div>
  );
}

/* ---------------- customers / vendors / items ---------------- */
function Customers({ state, dispatch, openModal, notify, canEdit }) {
  const rows = useMemo(() => state.customers.map((c) => {
    const open = state.invoices.filter((i) => i.customerId === c.id && i.status !== "draft" && i.status !== "paid").reduce((s, i) => s + docTotals(i).total, 0);
    const life = state.invoices.filter((i) => i.customerId === c.id && i.status === "paid").reduce((s, i) => s + docTotals(i).total, 0);
    return { ...c, open, life };
  }), [state]);
  return (
    <div>
      <div className="page-head">
        <div><div className="page-title">Customers</div><div className="page-sub">{state.customers.length} customers</div></div>
        {canEdit && <button className="btn btn-primary" onClick={() => openModal({ type: "customer" })}><Icon name="plus" size={15} /> New customer</button>}
      </div>
      <div className="card tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th className="num">Balance due</th><th className="num">Lifetime revenue</th><th /></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b>{c.company && c.company !== c.name && <div className="muted" style={{ fontSize: 11.5 }}>{c.company}</div>}</td>
                <td className="muted">{c.email}</td>
                <td className="muted">{c.phone}</td>
                <td className="num" style={{ fontWeight: 650, color: c.open > 0 ? "var(--red)" : "var(--ink)" }}>{fmt(c.open)}</td>
                <td className="num">{fmt(c.life)}</td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  {canEdit && (
                    <>
                      <button className="icon-btn" title="Edit" onClick={() => openModal({ type: "customer", editId: c.id })}><Icon name="edit" size={14} /></button>
                      <button className="icon-btn" title="Delete" onClick={() => { if (window.confirm(`Delete ${c.name}?`)) { dispatch({ type: "DELETE_CUSTOMER", id: c.id }); notify("Customer deleted"); } }}><Icon name="trash" size={14} /></button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function CustomerForm({ state, dispatch, onClose, notify, editId }) {
  const existing = state.customers.find((c) => c.id === editId);
  const [f, setF] = useState(existing || { name: "", company: "", email: "", phone: "" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = () => {
    if (!f.name.trim()) return notify("Customer name is required");
    if (editId) dispatch({ type: "UPDATE_CUSTOMER", payload: { ...f, id: editId } });
    else dispatch({ type: "ADD_CUSTOMER", payload: { ...f, id: uid() } });
    notify(existing ? "Customer updated" : "Customer added"); onClose();
  };
  return (
    <div className="frm">
      <div><label className="lbl">Name *</label><input className="inp" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Business or person name" /></div>
      <div><label className="lbl">Company</label><input className="inp" value={f.company} onChange={(e) => set("company", e.target.value)} /></div>
      <div className="frm-row">
        <div><label className="lbl">Email</label><input className="inp" value={f.email} onChange={(e) => set("email", e.target.value)} /></div>
        <div><label className="lbl">Phone</label><input className="inp" value={f.phone} onChange={(e) => set("phone", e.target.value)} /></div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>{existing ? "Save changes" : "Add customer"}</button>
      </div>
    </div>
  );
}
const VENDOR_CATS = ["Software", "Real Estate", "Marketing", "Supplies", "Professional Fees", "Utilities", "Travel", "Other"];
function Vendors({ state, dispatch, openModal, notify, canEdit }) {
  const rows = useMemo(() => state.vendors.map((v) => ({
    ...v, spend: state.expenses.filter((e) => e.vendorId === v.id).reduce((s, e) => s + Number(e.amount), 0),
  })), [state]);
  return (
    <div>
      <div className="page-head">
        <div><div className="page-title">Vendors</div><div className="page-sub">Who you pay</div></div>
        {canEdit && <button className="btn btn-primary" onClick={() => openModal({ type: "vendor" })}><Icon name="plus" size={15} /> New vendor</button>}
      </div>
      <div className="card tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Name</th><th>Email</th><th>Category</th><th className="num">Total spend</th><th /></tr></thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id}>
                <td style={{ fontWeight: 650 }}>{v.name}</td>
                <td className="muted">{v.email}</td>
                <td><span className="pill">{v.category}</span></td>
                <td className="num">{fmt(v.spend)}</td>
                <td className="num">
                  {canEdit && (
                    <button className="icon-btn" title="Delete" onClick={() => { if (window.confirm(`Delete ${v.name}?`)) { dispatch({ type: "DELETE_VENDOR", id: v.id }); notify("Vendor deleted"); } }}><Icon name="trash" size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function VendorForm({ dispatch, onClose, notify }) {
  const [f, setF] = useState({ name: "", email: "", category: "Software" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = () => {
    if (!f.name.trim()) return notify("Vendor name is required");
    dispatch({ type: "ADD_VENDOR", payload: { ...f, id: uid() } });
    notify("Vendor added"); onClose();
  };
  return (
    <div className="frm">
      <div><label className="lbl">Name *</label><input className="inp" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
      <div><label className="lbl">Email</label><input className="inp" value={f.email} onChange={(e) => set("email", e.target.value)} /></div>
      <div><label className="lbl">Category</label>
        <select className="inp" value={f.category} onChange={(e) => set("category", e.target.value)}>{VENDOR_CATS.map((c) => <option key={c}>{c}</option>)}</select>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Add vendor</button>
      </div>
    </div>
  );
}
function Items({ state, dispatch, openModal, notify, canEdit }) {
  return (
    <div>
      <div className="page-head">
        <div><div className="page-title">Products &amp; Services</div><div className="page-sub">Things you sell — drop them straight into invoices and quotes</div></div>
        {canEdit && <button className="btn btn-primary" onClick={() => openModal({ type: "item" })}><Icon name="plus" size={15} /> New item</button>}
      </div>
      <div className="card tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Name</th><th>Description</th><th>Type</th><th className="num">Rate</th><th /></tr></thead>
          <tbody>
            {state.items.map((it) => (
              <tr key={it.id}>
                <td style={{ fontWeight: 650 }}>{it.name}</td>
                <td className="muted">{it.description}</td>
                <td><span className="pill">{it.type}</span></td>
                <td className="num">{fmt(it.rate)}</td>
                <td className="num">
                  {canEdit && (
                    <button className="icon-btn" title="Delete" onClick={() => { if (window.confirm(`Delete ${it.name}?`)) { dispatch({ type: "DELETE_ITEM", id: it.id }); notify("Item deleted"); } }}><Icon name="trash" size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function ItemForm({ dispatch, onClose, notify }) {
  const [f, setF] = useState({ name: "", description: "", rate: "", type: "Service" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = () => {
    if (!f.name.trim()) return notify("Item name is required");
    if (!(+f.rate > 0)) return notify("Enter a valid rate");
    dispatch({ type: "ADD_ITEM", payload: { ...f, id: uid(), rate: +f.rate } });
    notify("Item added"); onClose();
  };
  return (
    <div className="frm">
      <div><label className="lbl">Name *</label><input className="inp" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
      <div><label className="lbl">Description</label><input className="inp" value={f.description} onChange={(e) => set("description", e.target.value)} /></div>
      <div className="frm-row">
        <div><label className="lbl">Rate</label><input type="number" min="0" step="0.01" className="inp" value={f.rate} onChange={(e) => set("rate", e.target.value)} /></div>
        <div><label className="lbl">Type</label>
          <select className="inp" value={f.type} onChange={(e) => set("type", e.target.value)}><option>Service</option><option>Product</option></select>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Add item</button>
      </div>
    </div>
  );
}

/* ---------------- chart of accounts ---------------- */
function AccountsView({ state }) {
  const s = useMemo(() => computeStats(state), [state]);
  const tax = taxSummary(state);
  const accounts = useMemo(() => {
    const catMap = {};
    state.expenses.forEach((e) => { catMap[e.category] = (catMap[e.category] || 0) + Number(e.amount); });
    const taxPayable = Math.max(0, tax.net);
    return [
      { num: "1000", name: "Business Checking", type: "Asset", bal: s.cash },
      { num: "1200", name: "Accounts Receivable", type: "Asset", bal: s.outstandingAmt },
      { num: "2100", name: "Sales Tax Payable", type: "Liability", bal: taxPayable },
      { num: "3000", name: "Owner's Equity", type: "Equity", bal: s.cash + s.outstandingAmt - taxPayable },
      { num: "4000", name: "Sales Income", type: "Income", bal: s.revenueAccrual },
      ...Object.entries(catMap).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([cat, v], i) => ({ num: String(5000 + i * 10), name: cat + " Expense", type: "Expense", bal: v })),
    ];
  }, [state, s, tax]);
  const types = ["Asset", "Liability", "Equity", "Income", "Expense"];
  return (
    <div>
      <div className="page-head">
        <div><div className="page-title">Chart of Accounts</div><div className="page-sub">Balances derived live from transactions</div></div>
      </div>
      <div className="card tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Account no.</th><th>Account</th><th>Type</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {types.map((tp) => {
              const rows = accounts.filter((a) => a.type === tp);
              if (!rows.length) return null;
              const sub = rows.reduce((x, a) => x + a.bal, 0);
              return (
                <React.Fragment key={tp}>
                  <tr><td colSpan="4" style={{ background: "#f6f8f9", fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: ".7px" }}>{tp}s — {fmt(sub)}</td></tr>
                  {rows.map((a) => (
                    <tr key={a.num}>
                      <td className="muted">{a.num}</td>
                      <td style={{ fontWeight: 600 }}>{a.name}</td>
                      <td><span className="pill">{a.type}</span></td>
                      <td className="num" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(a.bal)}</td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- reports ---------------- */
function ProfitLoss({ state }) {
  const year = new Date().getFullYear();
  const { income, expenses, incomeTotal, expTotal, net } = useMemo(() => {
    const invs = state.invoices.filter((i) => i.status !== "draft" && i.date.startsWith(String(year)));
    const incMap = {};
    invs.forEach((i) => i.lines.forEach((l) => { const k = l.description || "Services"; incMap[k] = (incMap[k] || 0) + (+l.qty || 0) * (+l.rate || 0); }));
    const income = Object.entries(incMap).sort((a, b) => b[1] - a[1]);
    const exps = state.expenses.filter((e) => e.date.startsWith(String(year)));
    const expMap = {};
    exps.forEach((e) => { expMap[e.category] = (expMap[e.category] || 0) + Number(e.amount); });
    const expenses = Object.entries(expMap).sort((a, b) => b[1] - a[1]);
    const incomeTotal = income.reduce((s, [, v]) => s + v, 0);
    const expTotal = expenses.reduce((s, [, v]) => s + v, 0);
    return { income, expenses, incomeTotal, expTotal, net: incomeTotal - expTotal };
  }, [state, year]);
  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="card-pad">
        <div style={{ fontWeight: 750, fontSize: 15 }}>{state.settings.companyName} — Profit &amp; Loss</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>January 1 – December 31, {year}</div>
        <div className="rpt-section">Income</div>
        {income.map(([k, v]) => <div key={k} className="rpt-row"><span>{k}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(v)}</span></div>)}
        <div className="rpt-row" style={{ fontWeight: 700 }}><span>Total income</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(incomeTotal)}</span></div>
        <div className="rpt-section">Operating expenses</div>
        {expenses.map(([k, v]) => <div key={k} className="rpt-row"><span>{k}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(v)}</span></div>)}
        <div className="rpt-row" style={{ fontWeight: 700 }}><span>Total expenses</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(expTotal)}</span></div>
        <div className="rpt-row total"><span>Net profit</span><span style={{ color: net >= 0 ? "var(--green-dark)" : "var(--red)", fontVariantNumeric: "tabular-nums" }}>{fmt(net)}</span></div>
      </div>
    </div>
  );
}
function BalanceSheet({ state }) {
  const s = useMemo(() => computeStats(state), [state]);
  const tax = taxSummary(state);
  const taxPayable = Math.max(0, tax.net);
  const assetsTotal = s.cash + s.outstandingAmt;
  const equity = assetsTotal - taxPayable;
  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="card-pad">
        <div style={{ fontWeight: 750, fontSize: 15 }}>{state.settings.companyName} — Balance Sheet</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>As of {today()} · cash basis</div>
        <div className="rpt-section">Assets</div>
        <div className="rpt-row"><span>Business checking</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(s.cash)}</span></div>
        <div className="rpt-row"><span>Accounts receivable</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(s.outstandingAmt)}</span></div>
        <div className="rpt-row" style={{ fontWeight: 700 }}><span>Total assets</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(assetsTotal)}</span></div>
        <div className="rpt-section">Liabilities</div>
        <div className="rpt-row"><span>Sales tax payable</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(taxPayable)}</span></div>
        <div className="rpt-section">Equity</div>
        <div className="rpt-row"><span>Owner's equity / retained earnings</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(equity)}</span></div>
        <div className="rpt-row total"><span>Total liabilities &amp; equity</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(taxPayable + equity)}</span></div>
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>✓ Assets = Liabilities + Equity</div>
      </div>
    </div>
  );
}
function Aging({ state }) {
  const data = useMemo(() => {
    const t = today();
    const byCust = {};
    state.invoices.filter((i) => i.status !== "draft" && i.status !== "paid").forEach((i) => {
      const total = docTotals(i).total;
      const past = daysBetween(i.dueDate, t);
      const b = past <= 0 ? 0 : past <= 30 ? 1 : past <= 60 ? 2 : past <= 90 ? 3 : 4;
      if (!byCust[i.customerId]) byCust[i.customerId] = { buckets: [0, 0, 0, 0, 0] };
      byCust[i.customerId].buckets[b] += total;
    });
    return Object.entries(byCust).map(([cid, v]) => ({ name: custName(state, cid), ...v }));
  }, [state]);
  const totals = [0, 1, 2, 3, 4].map((b) => data.reduce((s, r) => s + r.buckets[b], 0));
  const heads = ["Current", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"];
  return (
    <div className="card tbl-wrap" style={{ maxWidth: 860 }}>
      <table className="tbl">
        <thead><tr><th>Customer</th>{heads.map((h) => <th key={h} className="num">{h}</th>)}<th className="num">Total</th></tr></thead>
        <tbody>
          {data.length === 0 && <tr><td colSpan="7"><div className="empty">No outstanding receivables.</div></td></tr>}
          {data.map((r) => (
            <tr key={r.name}>
              <td style={{ fontWeight: 650 }}>{r.name}</td>
              {r.buckets.map((v, i) => <td key={i} className="num">{v ? fmt(v) : "—"}</td>)}
              <td className="num" style={{ fontWeight: 700 }}>{fmt(r.buckets.reduce((a, b) => a + b, 0))}</td>
            </tr>
          ))}
          <tr style={{ background: "#fafbfc", fontWeight: 700 }}>
            <td>Total</td>
            {totals.map((v, i) => <td key={i} className="num">{fmt(v)}</td>)}
            <td className="num">{fmt(totals.reduce((a, b) => a + b, 0))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
function Reports({ state }) {
  const [tab, setTab] = useState("pnl");
  return (
    <div>
      <div className="page-head">
        <div><div className="page-title">Reports</div><div className="page-sub">Fiscal year {new Date().getFullYear()}</div></div>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === "pnl" ? "on" : ""}`} onClick={() => setTab("pnl")}>Profit &amp; Loss</button>
        <button className={`tab ${tab === "bs" ? "on" : ""}`} onClick={() => setTab("bs")}>Balance Sheet</button>
        <button className={`tab ${tab === "aging" ? "on" : ""}`} onClick={() => setTab("aging")}>A/R Aging</button>
      </div>
      {tab === "pnl" && <ProfitLoss state={state} />}
      {tab === "bs" && <BalanceSheet state={state} />}
      {tab === "aging" && <Aging state={state} />}
    </div>
  );
}

/* ---------------- taxes ---------------- */
function Taxes({ state }) {
  const t = taxSummary(state);
  const rows = useMemo(() => last6Months().map((k) => {
    const collected = state.invoices.filter((i) => i.status !== "draft" && i.date.slice(0, 7) === k).reduce((s, i) => s + docTotals(i).tax, 0);
    const itc = state.expenses.filter((e) => e.date.slice(0, 7) === k).reduce((s, e) => s + Number(e.amount) * 0.1, 0);
    return { k, collected, itc };
  }), [state]);
  return (
    <div>
      <div className="page-head">
        <div><div className="page-title">Sales Tax</div><div className="page-sub">Input tax credits estimated at 10% of expenses</div></div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 16 }}>
        <StatCard label="Tax collected" value={fmt(t.collected)} sub="From invoices issued" />
        <StatCard label="Input tax credits" value={fmt(t.itc)} sub="Estimated on expenses" />
        <StatCard label={t.net >= 0 ? "Net tax payable" : "Net refund"} value={fmt(Math.abs(t.net))} sub={`Next return due ${nextFilingDeadline()}`} subClass={t.net >= 0 ? "neg" : "pos"} />
      </div>
      <div className="card tbl-wrap" style={{ maxWidth: 720 }}>
        <table className="tbl">
          <thead><tr><th>Period</th><th className="num">Collected</th><th className="num">ITC</th><th className="num">Net</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k}>
                <td style={{ fontWeight: 600 }}>{monthLabel(r.k)} {r.k.slice(0, 4)}</td>
                <td className="num">{fmt(r.collected)}</td>
                <td className="num">{fmt(r.itc)}</td>
                <td className="num" style={{ fontWeight: 650, color: r.collected - r.itc >= 0 ? "var(--ink)" : "var(--green-dark)" }}>{fmt(r.collected - r.itc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============== TEAM & ACCESS (admin only) ============== */
function UsersPanel({ state, dispatch, notify, me }) {
  const [f, setF] = useState({ name: "", email: "", password: "", role: "editor" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const add = async () => {
    if (!f.name.trim() || !f.email.trim()) return notify("Name and email are required");
    if (f.password.length < 6) return notify("Password must be at least 6 characters");
    if (state.users.some((u) => u.email.toLowerCase() === f.email.trim().toLowerCase())) return notify("A user with that email already exists");
    const hash = await hashPassword(f.password);
    dispatch({ type: "ADD_USER", payload: { id: uid(), name: f.name.trim(), email: f.email.trim(), role: f.role, hash } });
    setF({ name: "", email: "", password: "", role: "editor" });
    notify("User added — share their email and temporary password");
  };
  const resetPw = async (u) => {
    const pw = window.prompt(`Set a new password for ${u.name} (min 6 characters):`);
    if (!pw) return;
    if (pw.length < 6) return notify("Password too short");
    const hash = await hashPassword(pw);
    dispatch({ type: "UPDATE_USER", payload: { id: u.id, hash } });
    notify(`Password updated for ${u.name}`);
  };
  const remove = (u) => {
    if (u.id === me.id) return notify("You can't remove your own account");
    if (u.role === "admin" && state.users.filter((x) => x.role === "admin").length <= 1) return notify("You must keep at least one admin");
    if (window.confirm(`Remove ${u.name}? They will no longer be able to sign in.`)) {
      dispatch({ type: "DELETE_USER", id: u.id });
      notify("User removed");
    }
  };
  return (
    <div className="card card-pad" style={{ marginTop: 16 }}>
      <div className="card-title">Team &amp; access</div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th className="num">Actions</th></tr></thead>
          <tbody>
            {state.users.map((u) => (
              <tr key={u.id}>
                <td style={{ fontWeight: 650 }}>{u.name}{u.id === me.id && <span className="pill" style={{ marginLeft: 8 }}>you</span>}</td>
                <td className="muted">{u.email}</td>
                <td><span className="pill" style={{ textTransform: "capitalize" }}>{u.role}</span></td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-ghost btn-sm" style={{ marginRight: 6 }} onClick={() => resetPw(u)}>Reset password</button>
                  <button className="icon-btn" title="Remove user" onClick={() => remove(u)}><Icon name="trash" size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 1fr .9fr auto", gap: 8, marginTop: 12, alignItems: "end" }}>
        <div><label className="lbl">Full name</label><input className="inp" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
        <div><label className="lbl">Email</label><input className="inp" value={f.email} onChange={(e) => set("email", e.target.value)} /></div>
        <div><label className="lbl">Temporary password</label><input className="inp" type="password" value={f.password} onChange={(e) => set("password", e.target.value)} /></div>
        <div>
          <label className="lbl">Role</label>
          <select className="inp" value={f.role} onChange={(e) => set("role", e.target.value)}>
            <option value="admin">Admin</option>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        <button className="btn btn-primary" onClick={add}><Icon name="plus" size={14} /> Add user</button>
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
        Admin: full control including users, settings and backups · Editor: creates and edits records · Viewer: read-only dashboards and reports.
      </p>
    </div>
  );
}

/* ---------------- settings / backups ---------------- */
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "INR"];
function SettingsView({ state, dispatch, notify, me }) {
  const st = state.settings;
  const [f, setF] = useState({ ...st });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = () => { dispatch({ type: "UPDATE_SETTINGS", payload: f }); notify("Settings saved"); };
  const exportJSON = () => downloadFile(`ledgerly-backup-${today()}.json`, JSON.stringify(state, null, 2), "application/json");
  const exportInvoicesCSV = () => downloadFile(`invoices-${today()}.csv`, toCSV(state.invoices.map((i) => {
    const t = docTotals(i);
    return { Number: i.number, Customer: custName(state, i.customerId), Date: i.date, Due: i.dueDate, Status: invStatus(i), Subtotal: t.subtotal.toFixed(2), Tax: t.tax.toFixed(2), Total: t.total.toFixed(2) };
  })), "text/csv");
  const exportExpensesCSV = () => downloadFile(`expenses-${today()}.csv`, toCSV(state.expenses.map((e) => ({
    Date: e.date, Vendor: vendName(state, e.vendorId), Category: e.category, Description: e.description, Method: e.paymentMethod, Amount: Number(e.amount).toFixed(2),
  }))), "text/csv");
  const onImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.invoices) || !Array.isArray(data.customers)) throw new Error("bad shape");
        dispatch({
          type: "IMPORT_STATE",
          payload: {
            ...seed(), ...data,
            settings: { ...seed().settings, ...(data.settings || {}) },
            users: Array.isArray(data.users) ? data.users : state.users,
            session: state.session,
          },
        });
        notify("Backup imported successfully");
      } catch (err) {
        notify("Import failed — not a valid Ledgerly backup file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };
  return (
    <div>
      <div className="page-head">
        <div><div className="page-title">Settings</div><div className="page-sub">Company profile, documents, and data safety</div></div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1.2fr 1fr", alignItems: "start" }}>
        <div className="card card-pad">
          <div className="card-title">Company profile</div>
          <div className="frm">
            <div><label className="lbl">Company name</label><input className="inp" value={f.companyName} onChange={(e) => set("companyName", e.target.value)} /></div>
            <div><label className="lbl">Address line (shown on documents)</label><input className="inp" value={f.address} onChange={(e) => set("address", e.target.value)} /></div>
            <div><label className="lbl">Email</label><input className="inp" value={f.email} onChange={(e) => set("email", e.target.value)} /></div>
            <div className="frm-row">
              <div>
                <label className="lbl">Currency</label>
                <select className="inp" value={f.currency} onChange={(e) => set("currency", e.target.value)}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div><label className="lbl">Default tax rate %</label><input type="number" min="0" className="inp" value={f.taxRate} onChange={(e) => set("taxRate", e.target.value)} /></div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary" onClick={save}>Save settings</button>
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gap: 16 }}>
          <div className="card card-pad">
            <div className="card-title">Backup &amp; restore</div>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
              Your data lives in this browser only. Export a backup regularly and store it somewhere safe.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={exportJSON}>Export backup (JSON)</button>
              <input type="file" accept="application/json,.json" style={{ display: "none" }} id="import-file" onChange={onImport} />
              <label htmlFor="import-file" className="btn btn-ghost" style={{ cursor: "pointer" }}>Import backup…</label>
            </div>
          </div>
          <div className="card card-pad">
            <div className="card-title">Export for your accountant</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-ghost" onClick={exportInvoicesCSV}>Invoices (CSV)</button>
              <button className="btn btn-ghost" onClick={exportExpensesCSV}>Expenses (CSV)</button>
            </div>
          </div>
          <div className="card card-pad" style={{ borderColor: "#f3c1bd" }}>
            <div className="card-title" style={{ color: "var(--red)" }}>Danger zone</div>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>Wipes everything — including user accounts — and restores demo data. You'll set up the admin account again.</p>
            <button className="btn btn-danger" onClick={() => { if (window.confirm("Reset ALL data (including users) to the demo dataset? This cannot be undone.")) { dispatch({ type: "RESET" }); notify("Demo data restored"); } }}>
              <Icon name="trash" size={14} /> Reset all data
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- styles ---------------- */
const CSS = `
:root{--green:#2ca01c;--green-dark:#1f7a12;--line:#e4e7ec}
*{box-sizing:border-box;margin:0;padding:0}
html,body,#root{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1c2226;background:#f4f6f8;font-size:14px}
.app{display:flex;height:100vh;overflow:hidden}
.sidebar{width:224px;background:#20262b;color:#c7d0d8;display:flex;flex-direction:column;flex-shrink:0}
.brand{display:flex;align-items:center;gap:10px;padding:18px 16px;border-bottom:1px solid rgba(255,255,255,.08)}
.brand-logo{width:30px;height:30px;background:#2ca01c;border-radius:8px;display:grid;place-items:center;color:#fff;font-weight:800;font-size:15px}
.brand-name{color:#fff;font-weight:700;font-size:16px;letter-spacing:.2px}
.brand-sub{font-size:10px;color:#8ea0ad;letter-spacing:1.4px;text-transform:uppercase}
.nav{flex:1;padding:10px 8px;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:13.5px;color:#aebac4;border:none;background:none;width:100%;text-align:left;transition:background .15s,color .15s;font-family:inherit}
.nav-item:hover{background:rgba(255,255,255,.06);color:#fff}
.nav-item.active{background:rgba(44,160,28,.16);color:#fff;box-shadow:inset 3px 0 0 #2ca01c;border-radius:0 8px 8px 0}
.side-foot{padding:12px;border-top:1px solid rgba(255,255,255,.08);display:flex;align-items:center;gap:10px}
.avatar{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#2ca01c,#12a594);display:grid;place-items:center;color:#fff;font-weight:700;font-size:12px;flex-shrink:0}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.topbar{height:60px;background:#fff;border-bottom:1px solid #e4e7ec;display:flex;align-items:center;gap:16px;padding:0 24px;flex-shrink:0}
.search{position:relative;flex:1;max-width:420px}
.search input{width:100%;padding:8px 12px 8px 34px;border:1px solid #e4e7ec;border-radius:8px;font-size:13px;background:#f8fafc;font-family:inherit}
.search input:focus{outline:none;border-color:#2ca01c;box-shadow:0 0 0 3px rgba(44,160,28,.13);background:#fff}
.search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#667085}
.search-pop{position:absolute;top:calc(100% + 6px);left:0;right:0;background:#fff;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 12px 32px rgba(16,24,40,.14);z-index:70;overflow:hidden}
.search-item{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;cursor:pointer;font-size:13px}
.search-item:hover{background:#f4f8f3}
.search-tag{font-size:11px;color:#667085;background:#f2f4f7;padding:2px 7px;border-radius:99px;flex-shrink:0}
.content{flex:1;overflow-y:auto;padding:24px 28px 60px}
.page-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;gap:12px;flex-wrap:wrap}
.page-title{font-size:21px;font-weight:700;letter-spacing:-.2px}
.page-sub{color:#667085;font-size:13px;margin-top:2px}
.btn{display:inline-flex;align-items:center;gap:7px;border-radius:8px;border:1px solid transparent;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;background:#eef1f4;color:#1c2226;transition:.15s;font-family:inherit}
.btn:hover{background:#e2e6ea}
.btn-primary{background:#2ca01c;color:#fff}
.btn-primary:hover{background:#1f7a12}
.btn-primary:disabled{opacity:.6;cursor:default}
.btn-ghost{background:#fff;border-color:#e4e7ec}
.btn-ghost:hover{background:#f6f8f9}
.btn-danger{background:#fff;border-color:#f3c1bd;color:#d92d20}
.btn-danger:hover{background:#fef3f2}
.btn-sm{padding:5px 10px;font-size:12px}
.icon-btn{background:none;border:none;cursor:pointer;color:#667085;padding:6px;border-radius:6px;display:inline-flex;font-family:inherit}
.icon-btn:hover{background:#f2f4f7;color:#1c2226}
.icon-btn:disabled{opacity:.35;cursor:default}
.card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.card-pad{padding:18px 20px}
.card-title{font-size:14px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.grid{display:grid;gap:16px}
.grid-4{grid-template-columns:repeat(4,1fr)}
.grid-2{grid-template-columns:2fr 1fr}
@media(max-width:1100px){.grid-4{grid-template-columns:repeat(2,1fr)}.grid-2{grid-template-columns:1fr}}
.stat{padding:16px 18px}
.stat-label{font-size:11.5px;color:#667085;font-weight:600;text-transform:uppercase;letter-spacing:.6px}
.stat-value{font-size:24px;font-weight:750;margin-top:6px;font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.stat-sub{font-size:12px;color:#667085;margin-top:4px}
.stat-sub.neg{color:#d92d20}.stat-sub.pos{color:#1f7a12}
.tbl-wrap{overflow-x:auto}
table.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#667085;padding:10px 14px;border-bottom:1px solid #e4e7ec;background:#fafbfc}
.tbl td{padding:11px 14px;border-bottom:1px solid #eef1f4;vertical-align:middle}
.tbl tbody tr:last-child td{border-bottom:none}
.tbl tbody tr{transition:background .12s}
.tbl tbody tr:hover{background:#f8faf9}
.tbl .num{text-align:right;font-variant-numeric:tabular-nums}
.tbl th.num{text-align:right}
.clickable{cursor:pointer}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:99px}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.b-paid{background:#e8f6e6;color:#1f7a12}
.b-sent{background:#e8effe;color:#2f57d8}
.b-overdue{background:#fdecea;color:#c0262c}
.b-draft{background:#eef1f4;color:#5b6470}
.b-accepted{background:#e8f6e6;color:#1f7a12}
.b-declined{background:#fdecea;color:#c0262c}
.b-invoiced{background:#f1ebfd;color:#6d3fc0}
.b-expired{background:#fdf3e7;color:#b54708}
.overlay{position:fixed;inset:0;background:rgba(20,26,31,.5);display:grid;place-items:center;z-index:100;padding:20px;animation:fadeIn .15s ease}
.modal{background:#fff;border-radius:14px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.25);animation:pop .18s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e4e7ec}
.modal-head h3{font-size:16px}
.modal-body{padding:20px;overflow-y:auto}
.frm{display:grid;gap:14px}
.frm-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.lbl{display:block;font-size:12px;font-weight:650;color:#3c4450;margin-bottom:5px}
.inp{width:100%;padding:8px 11px;border:1px solid #d4dae1;border-radius:8px;font-size:13.5px;background:#fff;color:#1c2226;font-family:inherit}
.inp:focus{outline:none;border-color:#2ca01c;box-shadow:0 0 0 3px rgba(44,160,28,.13)}
textarea.inp{resize:vertical;min-height:78px}
.filters{display:flex;gap:6px;flex-wrap:wrap}
.chip{border:1px solid #e4e7ec;background:#fff;border-radius:99px;padding:5px 12px;font-size:12.5px;font-weight:600;color:#667085;cursor:pointer;transition:.15s;font-family:inherit}
.chip:hover{color:#1c2226}
.chip.on{background:#20262b;color:#fff;border-color:#20262b}
.toast{position:fixed;bottom:22px;right:22px;background:#20262b;color:#fff;padding:11px 16px;border-radius:10px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:200;display:flex;gap:8px;align-items:center;animation:slideUp .2s ease}
@keyframes slideUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.empty{padding:44px 20px;text-align:center;color:#667085;font-size:13px}
.banner{display:flex;gap:10px;align-items:center;background:#fdf3e7;border:1px solid #f6d9b8;color:#8a4b0f;padding:11px 14px;border-radius:10px;font-size:13px;margin-bottom:16px}
.bar-chart{display:flex;gap:18px;padding:8px 4px 0}
.bar-group{flex:1;display:flex;flex-direction:column;align-items:center;gap:8px}
.bar-pair{display:flex;gap:5px;align-items:flex-end;justify-content:center;height:170px;width:100%}
.bar{width:22px;border-radius:5px 5px 2px 2px;min-height:3px;transition:opacity .15s}
.bar:hover{opacity:.75}
.bar.income{background:#2ca01c}
.bar.expense{background:#c9d2dc}
.bar-label{font-size:11.5px;color:#667085;font-weight:600}
.legend{display:flex;gap:16px;font-size:12px;color:#667085}
.dot{width:9px;height:9px;border-radius:3px;display:inline-block;margin-right:6px}
.donut-wrap{display:flex;align-items:center;gap:20px}
.donut{width:150px;height:150px;border-radius:50%;position:relative;flex-shrink:0}
.donut::after{content:"";position:absolute;inset:26px;background:#fff;border-radius:50%;z-index:0}
.donut-center{position:absolute;inset:0;display:grid;place-items:center;z-index:1;text-align:center}
.mini-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #f0f2f5;font-size:13px;gap:10px}
.mini-row:last-child{border-bottom:none}
.tabs{display:flex;gap:4px;border-bottom:1px solid #e4e7ec;margin-bottom:18px}
.tab{padding:9px 14px;font-size:13.5px;font-weight:600;color:#667085;cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit}
.tab.on{color:#1f7a12;border-color:#2ca01c}
.rpt-row{display:flex;justify-content:space-between;padding:8px 0;font-size:13.5px;border-bottom:1px solid #f2f4f6}
.rpt-row.total{font-weight:750;border-top:2px solid #1c2226;border-bottom:3px double #1c2226;margin-top:6px;padding:10px 0;font-size:14px}
.rpt-section{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#667085;font-weight:700;margin:16px 0 6px}
.menu-pop{position:absolute;top:calc(100% + 8px);right:0;background:#fff;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 12px 32px rgba(16,24,40,.16);min-width:190px;z-index:60;padding:6px;animation:pop .15s ease}
.menu-item{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border:none;background:none;font-size:13px;border-radius:7px;cursor:pointer;color:#1c2226;text-align:left;font-family:inherit}
.menu-item:hover{background:#f2f7f0}
.link{color:#1f7a12;font-weight:600;cursor:pointer;background:none;border:none;font-size:13px;padding:0;font-family:inherit}
.link:hover{text-decoration:underline}
.muted{color:#667085}
.right{text-align:right}
.pill{font-size:11px;background:#f2f4f7;color:#4a5560;padding:2px 8px;border-radius:99px;font-weight:600}
.receipt{border:1px solid #e4e7ec;border-radius:12px;padding:26px;position:relative}
.receipt-head{display:flex;justify-content:space-between;gap:12px;border-bottom:2px solid #20262b;padding-bottom:14px;margin-bottom:16px}
.stamp{position:absolute;top:38%;right:7%;transform:rotate(-12deg);border:3px solid #2ca01c;color:#1f7a12;font-weight:800;font-size:24px;letter-spacing:5px;padding:6px 18px;border-radius:10px;opacity:.8;text-transform:uppercase;pointer-events:none}
.auth-wrap{min-height:100vh;display:grid;place-items:center;background:radial-gradient(900px 500px at 15% -10%,rgba(44,160,28,.35),transparent),radial-gradient(700px 400px at 110% 110%,rgba(18,165,148,.25),transparent),#20262b;padding:20px}
.auth-card{width:100%;max-width:410px;background:#fff;border-radius:16px;padding:28px;box-shadow:0 24px 64px rgba(0,0,0,.35)}
@media print{
  body *{visibility:hidden}
  .print-area,.print-area *{visibility:visible}
  .print-area{position:fixed;inset:0;padding:24px;overflow:visible}
  .no-print{display:none!important}
}
`;

/* ---------------- app root ---------------- */
export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, init);
  const [view, setViewRaw] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [quoteOpenId, setQuoteOpenId] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef();

  setCurrency(state.settings.currency);

  useEffect(() => { document.title = "Ledgerly — Accounting"; }, []);
  useEffect(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }, [state]);

  const notify = (msg) => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 2600); };

  // ============ AUTH GATE ============
  const me = state.users.find((u) => u.id === state.session) || null;
  if (!me) {
    return (
      <>
        <style>{CSS}</style>
        <AuthScreen state={state} dispatch={dispatch} />
      </>
    );
  }

  const isAdmin = me.role === "admin";
  const canEdit = me.role !== "viewer";
  const ADMIN_ONLY = ["UPDATE_SETTINGS", "IMPORT_STATE", "RESET", "ADD_USER", "UPDATE_USER", "DELETE_USER"];

  const gDispatch = (action) => {
    const mutating = action.type.startsWith("ADD_") || action.type.startsWith("UPDATE_") || action.type.startsWith("DELETE_") || ["IMPORT_STATE", "RESET"].includes(action.type);
    if (mutating) {
      if (!canEdit) { notify("Your account is view-only — ask an admin for edit access"); return; }
      if (ADMIN_ONLY.includes(action.type) && !isAdmin) { notify("Admin access required for that action"); return; }
    }
    dispatch(action);
  };

  const setView = (v) => {
    setViewRaw(v);
    if (v !== "invoices") setOpenId(null);
    if (v !== "quotes") setQuoteOpenId(null);
  };
  const openInvoice = (id) => { setViewRaw("invoices"); setOpenId(id); };
  const openQuote = (id) => { setViewRaw("quotes"); setQuoteOpenId(id); };
  const closeModal = () => setModal(null);
  const logout = () => {
    setViewRaw("dashboard"); setModal(null); setOpenId(null); setQuoteOpenId(null);
    dispatch({ type: "SET_SESSION", payload: null });
  };

  let content;
  switch (view) {
    case "dashboard": content = <Dashboard state={state} setView={setView} openInvoice={openInvoice} />; break;
    case "invoices": content = <Invoices state={state} dispatch={gDispatch} openModal={setModal} notify={notify} openId={openId} setOpenId={setOpenId} canEdit={canEdit} />; break;
    case "quotes": content = <Quotes state={state} dispatch={gDispatch} openModal={setModal} notify={notify} openId={quoteOpenId} setOpenId={setQuoteOpenId} openInvoice={openInvoice} canEdit={canEdit} />; break;
    case "receipts": content = <Receipts state={state} />; break;
    case "expenses": content = <Expenses state={state} dispatch={gDispatch} openModal={setModal} notify={notify} canEdit={canEdit} />; break;
    case "customers": content = <Customers state={state} dispatch={gDispatch} openModal={setModal} notify={notify} canEdit={canEdit} />; break;
    case "vendors": content = <Vendors state={state} dispatch={gDispatch} openModal={setModal} notify={notify} canEdit={canEdit} />; break;
    case "items": content = <Items state={state} dispatch={gDispatch} openModal={setModal} notify={notify} canEdit={canEdit} />; break;
    case "accounts": content = <AccountsView state={state} />; break;
    case "reports": content = <Reports state={state} />; break;
    case "taxes": content = <Taxes state={state} />; break;
    case "settings": content = isAdmin ? <SettingsView state={state} dispatch={gDispatch} notify={notify} me={me} /> : <Dashboard state={state} setView={setView} openInvoice={openInvoice} />; break;
    default: content = null;
  }

  return (
    <div className="app">
      <style>{CSS}</style>
      <Sidebar view={view} setView={setView} me={me} company={state.settings.companyName} onLogout={logout} showSettings={isAdmin} />
      <div className="main">
        <TopBar view={view} state={state} setView={setView} openModal={setModal} openInvoice={openInvoice} openQuote={openQuote} canEdit={canEdit} />
        <div className="content">
          {!canEdit && (
            <div className="banner" style={{ background: "#e8effe", borderColor: "#c6d8fb", color: "#2f57d8" }}>
              You're signed in as a <b>&nbsp;viewer&nbsp;</b> — everything is read-only. Ask an admin to upgrade your role.
            </div>
          )}
          {content}
        </div>
      </div>

      {modal && modal.type === "invoice" && (
        <Modal title="New invoice" width={820} onClose={closeModal}>
          <InvoiceForm state={state} dispatch={gDispatch} onClose={closeModal} notify={notify} />
        </Modal>
      )}
      {modal && modal.type === "quote" && (
        <Modal title="New quote" width={820} onClose={closeModal}>
          <QuoteForm state={state} dispatch={gDispatch} onClose={closeModal} notify={notify} />
        </Modal>
      )}
      {modal && modal.type === "expense" && (
        <Modal title="New expense" onClose={closeModal}>
          <ExpenseForm state={state} dispatch={gDispatch} onClose={closeModal} notify={notify} />
        </Modal>
      )}
      {modal && modal.type === "customer" && (
        <Modal title={modal.editId ? "Edit customer" : "New customer"} onClose={closeModal}>
          <CustomerForm state={state} dispatch={gDispatch} onClose={closeModal} notify={notify} editId={modal.editId} />
        </Modal>
      )}
      {modal && modal.type === "vendor" && (
        <Modal title="New vendor" onClose={closeModal}>
          <VendorForm dispatch={gDispatch} onClose={closeModal} notify={notify} />
        </Modal>
      )}
      {modal && modal.type === "item" && (
        <Modal title="New product / service" onClose={closeModal}>
          <ItemForm dispatch={gDispatch} onClose={closeModal} notify={notify} />
        </Modal>
      )}

      {toast && <div className="toast"><Icon name="check" size={15} /> {toast}</div>}
    </div>
  );
}