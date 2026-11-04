import React, { useState, useEffect } from "react";
import { readUsage, getLimit, setLimit, nextResetMs } from "../lib/usage.js";

const fmtIn = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h} س ${m % 60} د` : `${m} د`;
};
const fmtAt = (ms) => new Intl.DateTimeFormat("ar-EG", { hour: "numeric", minute: "2-digit", weekday: "short" }).format(ms);

/* small meter inside the key dialog: how much of today's quota the app has used, and when it renews */
export default function UsageBar() {
  const [, tick] = useState(0);
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState("");
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    window.addEventListener("nclex-usage", f);
    const t = setInterval(f, 30000);
    return () => { window.removeEventListener("nclex-usage", f); clearInterval(t); };
  }, []);

  const u = readUsage();
  const { n: limit, learned } = getLimit();
  const pct = Math.min(100, Math.round((u.total / limit) * 100));
  const reset = nextResetMs();
  const out = !!u.quota || u.total >= limit;
  const level = out ? "full" : pct >= 80 ? "high" : "ok";

  return (
    <div className="usage" data-level={level}>
      <div className="usage-top">
        <b>استهلاك النهاردة</b>
        <span>{u.total} من {limit} طلب</span>
      </div>
      <div className="usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${Math.max(pct, u.total ? 3 : 0)}%` }} /></div>
      <div className="usage-foot">
        <span>{out ? "الحد اليومي خلص ❗ " : ""}بيتجدد {fmtAt(reset)} (بعد {fmtIn(reset - Date.now())})</span>
        {edit ? (
          <form className="usage-edit" onSubmit={(e) => { e.preventDefault(); setLimit(val); setEdit(false); }}>
            <input value={val} onChange={(e) => setVal(e.target.value.replace(/\D/g, ""))} inputMode="numeric" dir="ltr" autoFocus aria-label="حدّك اليومي" />
            <button type="submit" className="btn btn-ghost btn-sm">تمام</button>
          </form>
        ) : (
          <button type="button" className="usage-link" onClick={() => { setVal(String(limit)); setEdit(true); }}>
            {learned ? "الحد من Google" : "غيّر الحد"}
          </button>
        )}
      </div>
      <small>العدّاد تقديري ومحسوب من جهازك. Google بتجدّد الحد اليومي الساعة 12 بالليل بتوقيت المحيط الهادئ. حدودك الدقيقة موجودة في AI Studio.</small>
    </div>
  );
}
