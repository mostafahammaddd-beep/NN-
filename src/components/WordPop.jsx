import React, { useState, useEffect, useRef } from "react";
import { SpeakBtn, ClassifyBar } from "./rich.jsx";
import { translateWord, cachedMeaning } from "../lib/wordtr.js";

const ISW = (c) => /[A-Za-z'’-]/.test(c || "");

/* the English word under a screen point (works for mouse double-click and touch double-tap) */
function wordAt(x, y) {
  let node = null, off = 0;
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); node = p && p.offsetNode; off = p ? p.offset : 0; }
  else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); node = r && r.startContainer; off = r ? r.startOffset : 0; }
  if (!node || node.nodeType !== 3) return null;
  const t = node.nodeValue;
  let a = off, b = off;
  if (!ISW(t[a]) && ISW(t[a - 1])) { a--; b--; }
  while (a > 0 && ISW(t[a - 1])) a--;
  while (b < t.length && ISW(t[b])) b++;
  const raw = t.slice(a, b);
  const lead = raw.length - raw.replace(/^[-'’]+/, "").length;
  const word = raw.replace(/^[-'’]+|[-'’]+$/g, "");
  if (!/^[A-Za-z][A-Za-z'’-]+$/.test(word)) return null;
  const range = document.createRange();
  range.setStart(node, a + lead); range.setEnd(node, a + lead + word.length);
  const rect = range.getBoundingClientRect();
  if (!rect.width) return null;
  const block = node.parentElement && node.parentElement.closest("p,li,div,td,span");
  return { word, rect, context: (block ? block.textContent : t).slice(0, 300) };
}

/* double-click (or double-tap) any English word → a small round bubble with the speaker, the speed control and the Arabic meaning */
export default function WordPop({ apiKey }) {
  const [pop, setPop] = useState(null);       // { word, x, y, below }
  const [meaning, setMeaning] = useState("");
  const [state, setState] = useState("idle"); // idle | load | err
  const ref = useRef(null);
  const tap = useRef({ t: 0, x: 0, y: 0 });
  const keyRef = useRef(apiKey);
  keyRef.current = apiKey;

  useEffect(() => {
    const blocked = (el) => el && el.closest && el.closest("input,textarea,button,select,[contenteditable='true'],.wordpop");
    const open = (x, y, target) => {
      if (blocked(target)) return;
      const w = wordAt(x, y);
      if (!w) return;
      const half = Math.min(170, (window.innerWidth - 20) / 2) + 6;
      const cx = Math.min(Math.max(w.rect.left + w.rect.width / 2, half), window.innerWidth - half);
      const below = w.rect.top < 96;
      setPop({ word: w.word, context: w.context, x: cx, y: below ? w.rect.bottom + 8 : w.rect.top - 8, below });
    };
    const onDbl = (e) => open(e.clientX, e.clientY, e.target);
    const onUp = (e) => {                                            // touch: two quick taps in the same spot
      if (e.pointerType !== "touch") return;
      const now = performance.now(), p = tap.current;
      if (now - p.t < 320 && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 28) { tap.current = { t: 0, x: 0, y: 0 }; open(e.clientX, e.clientY, e.target); }
      else tap.current = { t: now, x: e.clientX, y: e.clientY };
    };
    const close = (e) => { if (!(e.target && e.target.closest && e.target.closest(".wordpop"))) setPop(null); };
    const esc = (e) => { if (e.key === "Escape") setPop(null); };
    document.addEventListener("dblclick", onDbl);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointerdown", close, true);
    const onScroll = () => setPop(null);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("dblclick", onDbl);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", esc);
    };
  }, []);

  useEffect(() => {
    if (!pop) return undefined;
    const hit = cachedMeaning(pop.word);
    if (hit) { setMeaning(hit); setState("idle"); return undefined; }
    if (!keyRef.current) { setMeaning(""); setState("nokey"); return undefined; }
    setMeaning(""); setState("load");
    const ctrl = new AbortController();
    translateWord({ apiKey: keyRef.current, word: pop.word, context: pop.context, signal: ctrl.signal, onQuick: (q) => { if (!ctrl.signal.aborted) { setMeaning(q); setState("idle"); } } })
      .then((m) => { if (!ctrl.signal.aborted) { setMeaning(m); setState(m ? "idle" : "err"); } })
      .catch(() => { if (!ctrl.signal.aborted) setState("err"); });
    return () => ctrl.abort();
  }, [pop && pop.word]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pop) return null;
  return (
    <div ref={ref} className="wordpop" data-below={pop.below} style={{ left: pop.x, top: pop.y }} role="dialog" aria-label={`معنى ${pop.word}`}>
      <div className="wordpop-head">
        <div className="wordpop-body">
          <bdi dir="ltr" className="wordpop-word">{pop.word}</bdi>
          <span className="wordpop-mean" data-s={state}>
            {state === "load" ? "بنترجم…" : state === "nokey" ? "حط مفتاح Gemini الأول 🔑" : state === "err" ? "مقدرتش أترجمها. جرّب تاني" : meaning}
          </span>
        </div>
        <SpeakBtn text={pop.word} label={`اسمع نطق ${pop.word}`} />
      </div>
      {/* any word you look up can be saved to the dictionary right here */}
      {state === "idle" && meaning && <ClassifyBar term={pop.word} line={`${pop.word} — ${meaning}`} src={null} />}
      {state === "err" && <ClassifyBar term={pop.word} line={pop.word} src={null} />}
    </div>
  );
}
