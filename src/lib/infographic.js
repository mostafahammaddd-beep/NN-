/* Infographics, the reliable way.
   The model writes a tiny JSON (≈400 tokens → a few seconds). Everything visual is done HERE by code:
   8 layouts, real text measurement (canvas), automatic font search, equal spacing, nothing can overflow or overlap. */
const COL = { coral: ["#E8664D", "#C94F38"], teal: ["#0E7C8F", "#0A5F6E"], violet: ["#6B5BD2", "#5442C9"], amber: ["#F2B134", "#D99410"], green: ["#2FA56B", "#228552"], sky: ["#25A3DC", "#1B86B8"] };
const ORDER = ["teal", "coral", "violet", "amber", "green", "sky"];
const INK = "#0B2A30";
const F = 'font-family="Arial,Helvetica,sans-serif"';
const AR = /[\u0600-\u06FF]/;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (x, n) => String(x == null ? "" : x).replace(/\*\*|[`#]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

export const INFO_SYSTEM = `You are the world's best medical infographic designer. You make study graphics for an Arabic-speaking nursing student preparing for the NCLEX-RN. A layout engine draws what you describe, so you only choose the structure and write precise, correct content.
Reply with ONE JSON object only (no markdown, no comments).

TYPES (pick the one that makes the topic easiest to remember):
cards    classification / overview / features of 2-6 things. {"type":"cards","icon":"🦠","title":"","ar":"","root":"parent concept (only for 2-4 items, drawn as a tree)","items":[{"h":"","e":"🔴","c":"coral","b":["Key: fact"]}],"tip":""}
steps    ordered process, 3-5 items (same item shape).
compare  exactly 2 items side by side (same item shape).
table    2-4 columns x 3-6 rows, e.g. hypo- vs hyper-: {"type":"table","icon":"","title":"","ar":"","cols":[{"h":"Hypothyroidism","c":"sky"},{"h":"Hyperthyroidism","c":"coral"}],"rows":[{"h":"Heart rate","v":["Slow","Fast"]}],"tip":""}
cycle    repeating loop, 3-6 items, at most ONE short bullet each.
mnemonic letters that spell a memory aid, 3-6 items: {"type":"mnemonic",...,"items":[{"l":"R","h":"Rescue","b":["Remove patient from danger"]}],"tip":""}
pyramid  priority / hierarchy, 3-5 items, FIRST item = top = highest priority; one short bullet each (e.g. ABC, Maslow, triage).
hub      one central idea with 3-6 surrounding aspects: root = the central idea, items = aspects (1-2 short bullets each).

CONTENT RULES
- English labels, spelled exactly right. "ar" = ONE short Arabic line (<= 45 chars) saying what the graphic shows; always give it. No other Arabic.
- Accuracy is everything: use CONTEXT (the question and lesson) as the source of truth; add only facts you are certain of (normal lab ranges, doses, classic signs, standard NCLEX priorities). If unsure, leave it out. Never invent numbers, drugs or anatomy. No duplicates, no overlap between items.
- Bullets are "Key: fact" (the key is shown in bold), 2-7 words each, max 3 per item (2 when there are 5-6 items). Facts the student must remember, with numbers/units when relevant.
- title <= 40 chars. h <= 22 chars. e = ONE fitting emoji. icon = ONE emoji for the whole topic. c = teal coral violet amber green sky (colour carries meaning: coral danger/abnormal/high-risk, green safe/normal, amber caution, violet info, sky neutral, teal main).
- tip = ONE key NCLEX exam point (<= 12 words) or "".
- If the request is generic ("draw this", "make a diagram"), illustrate the main concept of the CONTEXT.`;

export function parseInfo(text) {
  const s = String(text || ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no json");
  return JSON.parse(s.slice(a, b + 1));
}

/* ───────────── text measuring + wrapping (canvas gives exact widths; heuristic outside a browser) ───────────── */
let _c;
const ctx2d = () => { if (_c === undefined) { try { _c = document.createElement("canvas").getContext("2d"); } catch (e) { _c = null; } } return _c; };
const mw = (s, fs, bold) => {
  const c = ctx2d();
  if (c) { c.font = `${bold ? 800 : 500} ${fs}px Arial, Helvetica, sans-serif`; return c.measureText(s).width; }
  return String(s).length * fs * (bold ? 0.6 : 0.54);
};
function wrap(text, fs, maxW, bold) {
  const out = []; let line = "";
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    const t = line ? line + " " + w : w;
    if (line && mw(t, fs, bold) > maxW) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}
/* one <text>; if a single word is still too wide it is squeezed (never overflows) */
function T(x, y, s, fs, fill, o = {}) {
  const fit = o.maxW && mw(s, fs, o.b) > o.maxW ? ` textLength="${Math.floor(o.maxW)}" lengthAdjust="spacingAndGlyphs"` : "";
  const rtl = AR.test(s) ? ' direction="rtl" unicode-bidi="plaintext"' : "";
  return `<text x="${Math.round(x)}" y="${Math.round(y)}" font-size="${fs}" fill="${fill}" font-weight="${o.b ? 800 : 500}" text-anchor="${o.a || "middle"}" ${F}${rtl}${fit}${o.x || ""}>${esc(s)}</text>`;
}
/* "Key: detail" bullet → wrapped lines; the key (up to the colon) is drawn bold + coloured */
function bullet(text, fs, maxW) {
  const t = String(text).replace(/\s+/g, " ").trim(), k = t.indexOf(": ");
  const key = k > 0 && k <= 28 ? k + 1 : 0, sp = mw(" ", fs), lines = [];
  let line = "", lw = 0, off = 0;
  for (const w of t.split(" ")) {
    const ww = mw(w, fs, off < key);                      // the key is bold → measure it bold
    if (line && lw + sp + ww > maxW) { lines.push(line); line = w; lw = ww; } else { lw = line ? lw + sp + ww : ww; line = line ? line + " " + w : w; }
    off += w.length + 1;
  }
  if (line) lines.push(line);
  return { key, lines, over: lines.some((l) => mw(l, fs, false) > maxW * 1.04 && !l.includes(" ")) };
}
function bulletSvg(x, y, b, fs, kcol, lh = 1.27, maxW = 0) {
  let off = 0, g = "";
  b.lines.forEach((l, i) => {
    let body = esc(l);
    if (b.key > off) { const n = Math.min(b.key - off, l.length); body = `<tspan font-weight="800" fill="${kcol}">${esc(l.slice(0, n))}</tspan>${esc(l.slice(n))}`; }
    g += `<text x="${Math.round(x)}" y="${Math.round(y + i * fs * lh)}" font-size="${fs}" fill="${INK}" font-weight="500" text-anchor="start" ${F}${maxW && mw(l, fs, false) > maxW ? ` textLength="${Math.floor(maxW)}" lengthAdjust="spacingAndGlyphs"` : ""}>${body}</text>`;
    off += l.length + 1;
  });
  return g;
}
const SH = 'filter="url(#sh)"';

/* ───────────── layout 1: card grid (cards · steps · compare · tree) ───────────── */
function cardGrid(items, o) {
  const n = items.length, cols = o.cols || (n <= 4 ? n : 3), rows = Math.ceil(n / cols), gx = o.gap, gy = 22;
  const w = (1120 - gx * (cols - 1)) / cols, avail = o.bottom - o.top, rowH = (avail - gy * (rows - 1)) / rows;
  const HEAD = rows > 1 ? 68 : 80, R = rows > 1 ? 24 : 28, IC = 14 + R * 2 + 10, pad = 22, ind = 26, tw = w - IC - 12;
  const maxFs = rows > 1 ? 28 : n <= 2 ? 36 : 32;
  const measure = (fs) => items.map((it) => {
    const hf = Math.min(fs + 2, rows > 1 ? 26 : 30), hl = wrap(it.h, hf, tw, true).slice(0, 2);
    const bs = it.b.map((b) => bullet(b, fs, w - pad * 2 - ind));
    return { hf, hl, bs, h: bs.some((b) => b.over) ? 1e9 : HEAD + 20 + bs.reduce((a, x) => a + x.lines.length, 0) * fs * 1.27 + bs.length * 13 + 18 };
  });
  let m, fs;
  for (let t = 0; t < 4; t++) {
    for (fs = maxFs; fs >= 20; fs--) { m = measure(fs); if (Math.max(...m.map((x) => x.h)) <= rowH) break; }
    if (Math.max(...m.map((x) => x.h)) <= rowH) break;
    items.forEach((it) => { if (it.b.length > 1) it.b.pop(); });
  }
  const need = Math.max(...m.map((x) => x.h)), cardH = rows > 1 ? rowH : Math.min(rowH, need + 24);
  const y00 = o.top + (avail - (cardH * rows + gy * (rows - 1))) / 2;
  const cards = []; let g = "";
  items.forEach((it, i) => {
    const r = Math.floor(i / cols), c = i - r * cols, inRow = r === rows - 1 ? n - r * cols : cols;
    const x = 40 + (1120 - (inRow * w + (inRow - 1) * gx)) / 2 + c * (w + gx), y = y00 + r * (cardH + gy), cx = x + w / 2, main = COL[it.c][0], dark = COL[it.c][1], k = m[i];
    cards.push({ x, y, w, h: cardH, cx });
    g += `<rect x="${x}" y="${y}" width="${w}" height="${cardH}" rx="24" fill="#fff" ${SH}/>`;
    g += `<rect x="${x}" y="${y}" width="${w}" height="${cardH}" rx="24" fill="none" stroke="${main}" stroke-width="3"/>`;
    g += `<path d="M${x} ${y + HEAD}V${y + 24}A24 24 0 0 1 ${x + 24} ${y}H${x + w - 24}A24 24 0 0 1 ${x + w} ${y + 24}V${y + HEAD}Z" fill="url(#g-${it.c})"/>`;
    const icx = x + 14 + R, icy = y + HEAD / 2;
    if (o.badge === "steps") g += `<circle cx="${icx}" cy="${icy}" r="${R}" fill="#fff"/>` + T(icx, icy + R * 0.38, String(i + 1), Math.round(R * 1.1), dark, { b: 1 });
    else g += `<circle cx="${icx}" cy="${icy}" r="${R}" fill="#fff" fill-opacity=".22"/>` + T(icx, icy + R * 0.4, it.e || "●", Math.round(R * 1.15), "#fff");
    const hx = x + IC + tw / 2;
    k.hl.forEach((l, j) => { g += T(hx, icy - (k.hl.length - 1) * k.hf * 0.56 + k.hf * 0.36 + j * k.hf * 1.12, l, k.hf, "#fff", { b: 1, maxW: tw }); });
    let ty = y + HEAD + 16 + fs;
    k.bs.forEach((b) => {
      g += `<circle cx="${x + pad + 5}" cy="${Math.round(ty - fs * 0.3)}" r="5.5" fill="${main}"/>` + bulletSvg(x + pad + ind, ty, b, fs, dark, 1.27, w - pad * 2 - ind);
      ty += b.lines.length * fs * 1.27 + 13;
    });
    if (o.badge === "steps" && i < n - 1 && c < inRow - 1) { const ax = x + w + gx / 2, ay = y + cardH / 2; g += `<polygon points="${ax - 13},${ay - 20} ${ax + 13},${ay} ${ax - 13},${ay + 20}" fill="#0E7C8F"/>`; }
    if (o.badge === "vs" && i === 0) { const ax = x + w + gx / 2, ay = y + cardH / 2; g += `<circle cx="${ax}" cy="${ay}" r="32" fill="${INK}"/>` + T(ax, ay + 9, "VS", 26, "#fff", { b: 1 }); }
  });
  return { g, cards };
}

/* ───────────── layout 2: table (compare many attributes) ───────────── */
function table(d, o) {
  const cols = (Array.isArray(d.cols) ? d.cols : []).slice(0, 4).map((c, i) => ({ h: str(c && c.h, 24), c: c && COL[c.c] ? c.c : ORDER[i % 6] }));
  const nc = cols.length;
  const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 6).map((r) => ({ h: str(r && r.h, 30), v: (Array.isArray(r && r.v) ? r.v : []).slice(0, nc).map((x) => str(x, 60)) }));
  if (nc < 2 || rows.length < 2) throw new Error("table");
  const LW = nc >= 4 ? 220 : 270, CW = (1120 - LW) / nc, avail = o.bottom - o.top, HH = 78, nr = rows.length;
  const rowH = Math.min(122, (avail - HH) / nr);
  let fs;
  for (fs = 30; fs >= 20; fs--) {
    const lines = Math.max(...rows.map((r) => Math.max(wrap(r.h, fs, LW - 34, true).length, ...r.v.map((v) => wrap(v, fs, CW - 28).length))));
    if (lines * fs * 1.22 + 24 <= rowH) break;
  }
  const H = HH + rowH * nr, y0 = o.top + (avail - H) / 2, hf = Math.min(fs + 2, 30);
  let g = `<rect x="40" y="${y0}" width="1120" height="${H}" rx="24" fill="#fff" ${SH}/><clipPath id="tc"><rect x="40" y="${y0}" width="1120" height="${H}" rx="24"/></clipPath><g clip-path="url(#tc)">`;
  g += `<rect x="40" y="${y0}" width="${LW}" height="${HH}" fill="#EAF6F8"/>`;
  cols.forEach((c, i) => {
    const x = 40 + LW + i * CW, hl = wrap(c.h, hf, CW - 24, true).slice(0, 2);
    g += `<rect x="${x}" y="${y0}" width="${CW}" height="${HH}" fill="url(#g-${c.c})"/>`;
    hl.forEach((l, j) => { g += T(x + CW / 2, y0 + HH / 2 - (hl.length - 1) * hf * 0.56 + hf * 0.36 + j * hf * 1.12, l, hf, "#fff", { b: 1, maxW: CW - 24 }); });
  });
  rows.forEach((r, ri) => {
    const y = y0 + HH + ri * rowH;
    g += `<rect x="40" y="${y}" width="1120" height="${rowH}" fill="${ri % 2 ? "#FFFFFF" : "#F4FAFB"}"/><rect x="40" y="${y}" width="${LW}" height="${rowH}" fill="#EAF6F8" fill-opacity="${ri % 2 ? 0.55 : 0.9}"/>`;
    const ll = wrap(r.h, fs, LW - 34, true);
    ll.forEach((l, j) => { g += T(58, y + rowH / 2 - (ll.length - 1) * fs * 0.62 + fs * 0.35 + j * fs * 1.22, l, fs, INK, { b: 1, a: "start", maxW: LW - 34 }); });
    r.v.forEach((v, ci) => {
      const vl = wrap(v, fs, CW - 28);
      vl.forEach((l, j) => { g += T(40 + LW + ci * CW + CW / 2, y + rowH / 2 - (vl.length - 1) * fs * 0.62 + fs * 0.35 + j * fs * 1.22, l, fs, INK, { maxW: CW - 28 }); });
    });
  });
  for (let i = 0; i < nc; i++) g += `<line x1="${40 + LW + i * CW}" x2="${40 + LW + i * CW}" y1="${y0}" y2="${y0 + H}" stroke="#D5E6EA" stroke-width="2"/>`;
  g += `</g><rect x="40" y="${y0}" width="1120" height="${H}" rx="24" fill="none" stroke="#0E7C8F" stroke-width="3"/>`;
  return g;
}

/* ───────────── layout 3: mnemonic (big letters) ───────────── */
function mnemonic(items, o) {
  const n = items.length, cols = n > 4 ? 2 : 1, rn = Math.ceil(n / cols), gap = 18, w = (1120 - gap * (cols - 1)) / cols, avail = o.bottom - o.top;
  const rowH = Math.min(150, (avail - gap * (rn - 1)) / rn), tile = rowH - 24, tx = tile + 40, textW = w - tx - 22;
  const y0 = o.top + (avail - (rn * rowH + gap * (rn - 1))) / 2;
  let fs;
  const parts = (it, f) => ({ hl: wrap(it.h, f + 4, textW, true).slice(0, 2), bl: it.b.slice(0, 2).map((b) => bullet(b, f, textW)) });
  const height = (p, f) => p.hl.length * (f + 4) * 1.15 + p.bl.reduce((a, x) => a + x.lines.length, 0) * f * 1.25 + 8;
  for (fs = 30; fs >= 18; fs--) if (Math.max(...items.map((it) => height(parts(it, fs), fs))) <= rowH - 20) break;
  let g = "";
  items.forEach((it, i) => {
    const r = Math.floor(i / cols), c = i - r * cols, x = 40 + c * (w + gap), y = y0 + r * (rowH + gap), main = COL[it.c][0], dark = COL[it.c][1], p = parts(it, fs);
    g += `<rect x="${x}" y="${y}" width="${w}" height="${rowH}" rx="24" fill="#fff" ${SH}/><rect x="${x}" y="${y}" width="${w}" height="${rowH}" rx="24" fill="none" stroke="${main}" stroke-width="3"/>`;
    g += `<rect x="${x + 12}" y="${y + 12}" width="${tile}" height="${tile}" rx="20" fill="url(#g-${it.c})"/>` + T(x + 12 + tile / 2, y + 12 + tile / 2 + tile * 0.22, (it.l || it.h[0] || "?").toUpperCase().slice(0, 2), Math.round(tile * 0.62), "#fff", { b: 1 });
    let ty = y + (rowH - height(p, fs)) / 2 + (fs + 4) * 0.95;
    p.hl.forEach((l) => { g += T(x + tx, ty, l, fs + 4, dark, { b: 1, a: "start", maxW: textW }); ty += (fs + 4) * 1.15; });
    ty += 4;
    p.bl.forEach((b) => { g += bulletSvg(x + tx, ty, b, fs, dark, 1.25); ty += b.lines.length * fs * 1.25; });
  });
  return g;
}

/* ───────────── layout 4: pyramid (priority / hierarchy) ───────────── */
function pyramid(items, o) {
  const n = items.length, avail = o.bottom - o.top, gap = 6, lh = Math.min(124, (avail - gap * (n - 1)) / n), H = lh * n + gap * (n - 1), y0 = o.top + (avail - H) / 2;
  const cx = 360, topHW = 110, botHW = 322, hw = (y) => topHW + ((botHW - topHW) * (y - y0)) / H;
  let fs;
  for (fs = 28; fs >= 18; fs--) if (Math.max(...items.map((it) => wrap(it.b.slice(0, 2).join(". "), fs, 430).length)) * fs * 1.25 <= lh - 10) break;
  let g = "";
  items.forEach((it, i) => {
    const ya = y0 + i * (lh + gap), yb = ya + lh, ha = hw(ya), hb = hw(yb), ym = ya + lh / 2, main = COL[it.c][0], full = ha + hb - 36;
    g += `<polygon points="${cx - ha},${ya} ${cx + ha},${ya} ${cx + hb},${yb} ${cx - hb},${yb}" fill="url(#g-${it.c})" ${SH}/>`;
    let hf = 30, hl;
    for (; hf >= 18; hf--) { hl = wrap(it.h, hf, full, true); if (hl.length <= 2 && hl.length * hf * 1.12 <= lh - 12) break; }
    hl.forEach((l, j) => { g += T(cx, ym - (hl.length - 1) * hf * 0.56 + hf * 0.36 + j * hf * 1.12, l, hf, "#fff", { b: 1, maxW: full }); });
    g += `<line x1="${cx + (ha + hb) / 2 + 6}" y1="${ym}" x2="696" y2="${ym}" stroke="${main}" stroke-width="3" stroke-dasharray="6 7" stroke-linecap="round"/><rect x="700" y="${ya + 6}" width="7" height="${lh - 12}" rx="3.5" fill="${main}"/>`;
    const tl = wrap(it.b.slice(0, 2).join(". "), fs, 430);
    tl.forEach((l, j) => { g += T(724, ym - (tl.length - 1) * fs * 0.62 + fs * 0.35 + j * fs * 1.25, l, fs, INK, { a: "start", maxW: 436 }); });
  });
  return g;
}

/* ───────────── layout 5: hub (one idea, several aspects) ───────────── */
function hub(items, root, o) {
  const n = items.length, avail = o.bottom - o.top, nw = n >= 5 ? 318 : 380;
  const measure = (fs) => items.map((it) => ({ hl: wrap(it.h, fs + 4, nw - 30, true).slice(0, 2), bs: it.b.slice(0, 2).map((b) => bullet(b, fs, nw - 56)) }));
  const nodeH = (m, fs) => 26 + m.hl.length * (fs + 4) * 1.15 + m.bs.reduce((a, x) => a + x.lines.length, 0) * fs * 1.25 + m.bs.length * 6;
  const cap = Math.min(200, (avail - 110) / 2);
  let fs, m, nh;
  for (fs = 28; fs >= 17; fs--) { m = measure(fs); nh = Math.max(90, ...m.map((x) => nodeH(x, fs))); if (nh <= cap) break; }
  const yT = o.top + nh / 2 + 2, yB = o.bottom - nh / 2 - 2, L = 40 + nw / 2, Rr = 1160 - nw / 2, half = nw / 2 + 28, cy = (yT + yB) / 2;
  const POS = { 3: [[600, yT], [L, yB], [Rr, yB]], 4: [[L, yT], [Rr, yT], [L, yB], [Rr, yB]], 5: [[L, yT], [600, yT], [Rr, yT], [600 - half, yB], [600 + half, yB]], 6: [[L, yT], [600, yT], [Rr, yT], [L, yB], [600, yB], [Rr, yB]] }[n];
  const rc = n === 4 ? 92 : Math.max(48, Math.min(92, (yB - yT - nh) / 2 - 8));
  let g = "";
  POS.forEach(([x, y], i) => { g += `<line x1="600" y1="${cy}" x2="${x.toFixed(0)}" y2="${y.toFixed(0)}" stroke="${COL[items[i].c][0]}" stroke-opacity=".55" stroke-width="5" stroke-linecap="round"/>`; });
  g += `<circle cx="600" cy="${cy}" r="${rc}" fill="url(#hg)" ${SH}/>`;
  let rf = 30, rl;
  for (; rf >= 16; rf--) { rl = wrap(root, rf, rc * 1.55, true); if (rl.length <= 3 && rl.length * rf * 1.12 <= rc * 1.4) break; }
  rl.forEach((l, j) => { g += T(600, cy - (rl.length - 1) * rf * 0.56 + rf * 0.36 + j * rf * 1.12, l, rf, "#fff", { b: 1, maxW: rc * 1.6 }); });
  items.forEach((it, i) => {
    const [x, y] = POS[i], main = COL[it.c][0], dark = COL[it.c][1], X = x - nw / 2, Y = y - nh / 2, k = m[i];
    g += `<rect x="${X.toFixed(0)}" y="${Y.toFixed(0)}" width="${nw}" height="${nh}" rx="22" fill="#fff" ${SH}/><rect x="${X.toFixed(0)}" y="${Y.toFixed(0)}" width="${nw}" height="${nh}" rx="22" fill="none" stroke="${main}" stroke-width="3"/>`;
    g += `<rect x="${(X + 14).toFixed(0)}" y="${(Y + 10).toFixed(0)}" width="${nw - 28}" height="6" rx="3" fill="${main}"/>`;
    let ty = Y + 20 + (fs + 4) * 0.95;
    k.hl.forEach((l) => { g += T(x, ty, (it.e && k.hl.length === 1 && mw(it.e + " " + l, fs + 4, true) <= nw - 30 ? it.e + " " : "") + l, fs + 4, dark, { b: 1, maxW: nw - 30 }); ty += (fs + 4) * 1.15; });
    ty += 2;
    k.bs.forEach((b) => { g += `<circle cx="${(X + 24).toFixed(0)}" cy="${Math.round(ty - fs * 0.3)}" r="4.5" fill="${main}"/>` + bulletSvg(X + 40, ty, b, fs, dark, 1.25); ty += b.lines.length * fs * 1.25 + 6; });
  });
  return g;
}

/* ───────────── layout 6: cycle ───────────── */
function cycle(items, o) {
  const n = items.length, cy = (o.top + o.bottom) / 2, nw = 320, nh = 108, ry = (o.bottom - o.top) / 2 - nh / 2 - 8, rx = 560 - nw / 2;
  const ang = (i) => -Math.PI / 2 + (2 * Math.PI * i) / n, d = ((2 * Math.PI) / n) * 0.3;
  const P = (a) => [600 + rx * Math.cos(a), cy + ry * Math.sin(a)];
  let g = "";
  for (let i = 0; i < n; i++) {
    const [x1, y1] = P(ang(i) + d), [x2, y2] = P(ang(i + 1) - d);
    g += `<path d="M${x1.toFixed(0)} ${y1.toFixed(0)}A${rx} ${ry} 0 0 1 ${x2.toFixed(0)} ${y2.toFixed(0)}" fill="none" stroke="#0E7C8F" stroke-width="5" stroke-linecap="round" marker-end="url(#ar)"/>`;
  }
  items.forEach((it, i) => {
    const [x, y] = P(ang(i)), hl = wrap((it.e && mw(it.e + " " + it.h, 28, true) <= nw - 30 ? it.e + " " : "") + it.h, 28, nw - 30, true).slice(0, 2);
    const sub = hl.length === 1 && it.b[0] ? wrap(it.b[0].replace(/^[^:]{1,28}:\s*/, ""), 22, nw - 30)[0] : "";
    g += `<rect x="${(x - nw / 2).toFixed(0)}" y="${(y - nh / 2).toFixed(0)}" width="${nw}" height="${nh}" rx="28" fill="url(#g-${it.c})" ${SH}/>`;
    const lines = hl.length + (sub ? 0.75 : 0), top = y - (lines * 34) / 2 + 26;
    hl.forEach((l, j) => { g += T(x, top + j * 34, l, 28, "#fff", { b: 1, maxW: nw - 30 }); });
    if (sub) g += T(x, top + 34, sub, 22, "#fff", { x: ' fill-opacity=".92"', maxW: nw - 30 });
  });
  return g;
}

/* ───────────── assembly ───────────── */
const ALIAS = { tree: "cards", overview: "cards", process: "steps", flow: "steps", timeline: "steps", vs: "compare", versus: "compare", loop: "cycle", matrix: "table", comparison: "table", mnemo: "mnemonic", map: "hub", concept: "hub", priority: "pyramid", triangle: "pyramid" };
const MAXN = { cards: 6, steps: 5, compare: 2, cycle: 6, mnemonic: 6, pyramid: 5, hub: 6 };

export function renderInfographic(d) {
  let type = String(d.type || "cards").toLowerCase(); type = ALIAS[type] || type;
  if (type !== "table" && !MAXN[type]) type = "cards";
  const root = str(d.root, 36);
  const items = type === "table" ? [] : (Array.isArray(d.items) ? d.items : []).slice(0, MAXN[type]).map((it, i) => {
    const b = Array.isArray(it && it.b) ? it.b : it && it.b ? [it.b] : [];
    return { h: str(it && it.h, 40), l: str(it && it.l, 2), e: str(it && it.e, 4), c: it && COL[it.c] ? it.c : ORDER[i % 6], b: b.map((x) => str(x, 80)).filter(Boolean).slice(0, 4) };
  }).filter((it) => it.h);
  if (type !== "table" && (items.length < 2 || (type === "compare" && items.length !== 2) || (type === "hub" && (items.length < 3 || !root)) || ((type === "pyramid" || type === "cycle" || type === "mnemonic") && items.length < 3))) throw new Error("few items");
  if (type === "cards" && items.length > 4) items.forEach((it) => { it.b = it.b.slice(0, 2); });
  const title = str(d.title, 60), icon = str(d.icon, 4), ar = str(d.ar, 60), sub = ar || str(d.subtitle, 80);
  let tfs = 48; while (tfs > 28 && mw(title, tfs, true) > (icon ? 900 : 1020)) tfs--;
  const tip = str(d.tip, 100), bottom = tip ? 676 : 766, top = 160;
  let body = "";
  if (type === "table") body = table(d, { top, bottom });
  else if (type === "cycle") body = cycle(items, { top, bottom });
  else if (type === "mnemonic") body = mnemonic(items, { top, bottom });
  else if (type === "pyramid") body = pyramid(items, { top, bottom });
  else if (type === "hub") body = hub(items, root, { top, bottom });
  else {
    const tree = type === "cards" && root && items.length <= 4;
    const r = cardGrid(items, { top: tree ? 262 : top, bottom, gap: type === "steps" ? 52 : type === "compare" ? 88 : 24, badge: type === "steps" ? "steps" : type === "compare" ? "vs" : null });
    if (tree) {
      const y0 = r.cards[0].y, xs = r.cards.map((c) => c.cx);
      body += `<rect x="400" y="158" width="400" height="58" rx="29" fill="url(#hg)" ${SH}/>` + T(600, 197, root, 28, "#fff", { b: 1, maxW: 360 });
      body += `<path d="M600 216V239M${xs[0]} ${y0}V239H${xs[xs.length - 1]}V${y0}" stroke="#0E7C8F" stroke-width="4" fill="none" stroke-linejoin="round"/>`;
      xs.slice(1, -1).forEach((cx) => { body += `<path d="M${cx} 239V${y0}" stroke="#0E7C8F" stroke-width="4" fill="none"/>`; });
    }
    body += r.g;
  }
  const defs = Object.entries(COL).map(([k, [a, b]]) => `<linearGradient id="g-${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`).join("");
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="1200" height="800"><defs>${defs}` +
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EEF9FB"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient>` +
    `<linearGradient id="hg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0B2A30"/><stop offset="1" stop-color="#0E7C8F"/></linearGradient>` +
    `<pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="#0E7C8F" fill-opacity=".11"/></pattern>` +
    `<filter id="sh" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="${INK}" flood-opacity=".18"/></filter>` +
    `<marker id="ar" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0L8 4L0 8z" fill="#0E7C8F"/></marker></defs>` +
    `<rect width="1200" height="800" fill="url(#bg)"/><rect width="1200" height="800" fill="url(#dots)"/>` +
    `<rect x="40" y="28" width="1120" height="112" rx="28" fill="url(#hg)" ${SH}/>`;
  if (icon) svg += `<circle cx="108" cy="84" r="40" fill="#fff" fill-opacity=".16"/>` + T(108, 100, icon, 44, "#fff");
  svg += T(600, sub ? 82 : 96, title, tfs, "#fff", { b: 1, maxW: icon ? 920 : 1040 });
  if (sub) svg += T(600, 122, sub, 26, "#9FE3F7", { maxW: 1000 });
  svg += body;
  if (tip) {
    let f = 26; while (f > 20 && mw(tip, f, true) > 1050) f--;
    svg += `<rect x="40" y="696" width="1120" height="80" rx="24" fill="#FFF4E0" stroke="#F2B134" stroke-width="3"/>` + T(600, 724, "NCLEX TIP", 20, "#C07F0A", { b: 1, x: ' letter-spacing="3"' }) + T(600, 759, tip, f, INK, { b: 1, maxW: 1060 });
  }
  svg += "</svg>";
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("svg");
  return svg;
}
