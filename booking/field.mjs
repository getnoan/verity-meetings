/**
 * The universe behind the booking hero: a company graph drawn as a star field
 * with a 2D canvas, so this service stays zero-dependency (the original is a
 * three.js scene with bloom).
 *
 * Same data and the same recipe as the site's /api preset: the company
 * graph (/assets/company-graph.json, proxied same-origin from BOOKING_FONT_ORIGIN), every
 * kind, at most 520 points sliced the way the site's sliceGraph slices (the tappable
 * ones kept and teal, the rest an even stride), the focal point pushed right
 * (focusX 0.68). The /facts preset keeps facts only, and no thread in the graph
 * touches a fact, so that one is a field without threads; this one has them.
 * Pearl points on the site's size spread (5 + r^2.6 * 26),
 * far ones hazed into the ground and out-of-focus ones softened; threads asleep at
 * the site's resting level with a signal firing along a few at a time; a slow
 * drift; 30 fps. Below 820px or under reduced motion it is one still frame, and it
 * pauses when scrolled away or the tab is hidden, as the site's does.
 *
 * Served as /assets/field.js; it draws into any <canvas data-field>.
 */
export const FIELD_JS = `(() => {
"use strict";
const canvas = document.querySelector("canvas[data-field]");
if (!canvas || !canvas.getContext) return;
const ctx = canvas.getContext("2d");
const PEARL = [226, 220, 203], TEAL = [94, 232, 192], LIT = [254, 134, 71];
const P = { kinds: null, max: 520, hotspots: true, focusX: 0.62, fps: 30, lines: 0.13, signalEvery: 0.9 };
const STILL_BELOW = 820;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* one soft glow per colour, drawn once: the bloom the site's shader adds */
function sprite(rgb) {
  const s = document.createElement("canvas"); s.width = s.height = 64;
  const g = s.getContext("2d"), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(" + rgb + ",1)"); grd.addColorStop(0.18, "rgba(" + rgb + ",0.55)");
  grd.addColorStop(0.45, "rgba(" + rgb + ",0.12)"); grd.addColorStop(1, "rgba(" + rgb + ",0)");
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64); return s;
}
const GLOW = { pearl: sprite(PEARL), teal: sprite(TEAL), lit: sprite(LIT) };

let pts = [], edges = [], cx = 0, cy = 0, cz = 0, radius = 1, w = 0, h = 0, dpr = 1;
let t0 = performance.now(), last = 0, running = false, signals = [], nextSignal = 0;

function load(g) {
  // the site's sliceGraph: the tappable ones always stay, the rest an even stride
  const want = P.kinds ? new Set(P.kinds.map(k => g.kinds.indexOf(k))) : null;
  const hot = new Set(P.hotspots ? (g.h || []).map(x => x.i) : []);
  let idx = [];
  for (let i = 0; i < g.k.length; i++) if (hot.has(i) || !want || want.has(g.k[i])) idx.push(i);
  if (P.max && idx.length > P.max) {
    const rest = idx.filter(i => !hot.has(i)), room = Math.max(0, P.max - hot.size), stride = rest.length / room;
    const picked = new Set();
    for (let q = 0; q < room; q++) picked.add(rest[Math.floor(q * stride)]);
    idx = idx.filter(i => hot.has(i) || picked.has(i));
  }
  const at = new Map();
  pts = idx.map((i, n) => {
    at.set(i, n);
    const r = ((i * 7919) % 1000) / 1000;
    return { x: g.p[i * 3], y: g.p[i * 3 + 1], z: g.p[i * 3 + 2], size: hot.has(i) ? 18 : 5 + Math.pow(r, 2.6) * 26,
      hot: hot.has(i), phase: (i * 0.37) % 6.283, sx: 0, sy: 0, depth: 0, vis: 0 };
  });
  edges = [];
  for (let e = 0; e < g.e.length; e += 2) {
    const a = at.get(g.e[e]), b = at.get(g.e[e + 1]);
    if (a !== undefined && b !== undefined) edges.push([a, b]);
  }
  for (const p of pts) { cx += p.x; cy += p.y; cz += p.z; }
  cx /= pts.length; cy /= pts.length; cz /= pts.length;
  for (const p of pts) radius = Math.max(radius, Math.hypot(p.x - cx, p.y - cy, p.z - cz));
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  w = canvas.clientWidth; h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
}

function project(time) {
  // a slow orbit and a slight breath in pitch: the site's field after the settle
  const yaw = 0.6 + time * 0.018, pitch = 0.32 + Math.sin(time * 0.05) * 0.05;
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const dist = radius * 1.9, f = Math.max(w, h) * 0.95;
  const ox = (P.focusX - 0.5) * w;
  for (const p of pts) {
    const x = p.x - cx, y = p.y - cy, z = p.z - cz;
    const x1 = x * cyw - z * syw, z1 = x * syw + z * cyw;
    const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    const zc = z2 + dist;
    p.vis = zc > 0.05;
    p.depth = zc / dist;                      // ~1 at the focal plane
    p.sx = w / 2 + ox + (x1 * f) / zc;
    p.sy = h / 2 + (y1 * f) / zc;
  }
}

function draw(time) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  project(time);
  // threads, asleep: the site's resting line level
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(" + PEARL + "," + P.lines + ")";
  ctx.beginPath();
  for (const [a, b] of edges) {
    const A = pts[a], B = pts[b];
    if (!A.vis || !B.vis) continue;
    ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy);
  }
  ctx.stroke();
  // points, back to front: far ones haze into the ground, off-focus ones soften
  ctx.globalCompositeOperation = "lighter";
  const order = pts.map((p, i) => i).sort((i, j) => pts[j].depth - pts[i].depth);
  for (const i of order) {
    const p = pts[i];
    if (!p.vis) continue;
    const fog = Math.max(0.12, Math.min(1, 1.55 - p.depth * 0.75));
    const blur = Math.min(1, Math.abs(p.depth - 1) * 1.6);
    const tw = 1 + 0.15 * Math.sin(time * 1.3 + p.phase);
    const core = Math.max(0.6, (p.size * 0.07) / p.depth);          // most pin-pricks, a few large
    const a = Math.min(1, fog * (p.hot ? 1 : 0.8) * tw);
    // the halo (the site's bloom), wider and fainter out of focus
    const halo = core * (3.2 + blur * 3);
    ctx.globalAlpha = a * (0.22 + (p.hot ? 0.12 : 0)) * (1 - blur * 0.3);
    ctx.drawImage(p.hot ? GLOW.teal : GLOW.pearl, p.sx - halo, p.sy - halo, halo * 2, halo * 2);
    // the point itself, crisp in focus, soft off it
    ctx.globalAlpha = a * (1 - blur * 0.6);
    ctx.fillStyle = "rgb(" + (p.hot ? TEAL : PEARL) + ")";
    ctx.beginPath(); ctx.arc(p.sx, p.sy, core * (1 + blur * 0.8), 0, 6.283); ctx.fill();
  }
  // signals firing along a few threads at a time (the site's "neurons firing")
  for (const s of signals) {
    const k = (time - s.at) / s.dur;
    if (k < 0 || k > 1) continue;
    const A = pts[s.a], B = pts[s.b];
    if (!A.vis || !B.vis) continue;
    const x = A.sx + (B.sx - A.sx) * k, y = A.sy + (B.sy - A.sy) * k, fade = Math.sin(Math.PI * k);
    ctx.globalAlpha = 0.35 * fade;
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(" + TEAL + ",1)"; ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(x, y); ctx.stroke();
    ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.9 * fade;
    ctx.drawImage(GLOW.teal, x - 9, y - 9, 18, 18);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
}

function tick(now) {
  if (!running) return;
  requestAnimationFrame(tick);
  if (now - last < 1000 / P.fps - 2) return;
  last = now;
  const time = (now - t0) / 1000;
  if (edges.length && time > nextSignal) {
    const [a, b] = edges[(Math.random() * edges.length) | 0];
    signals.push({ a, b, at: time, dur: 1.1 + Math.random() * 0.8 });
    signals = signals.filter(s => time - s.at < s.dur);
    nextSignal = time + P.signalEvery * (0.5 + Math.random());
  }
  draw(time);
}

const still = () => reduced || canvas.clientWidth < STILL_BELOW;
function inView() { const r = canvas.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; }
function sync() {
  const go = !still() && !document.hidden && inView();
  if (go && !running) { running = true; last = 0; requestAnimationFrame(tick); }
  if (!go) { running = false; draw((performance.now() - t0) / 1000); }
}

fetch("/assets/company-graph.json").then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(g => {
  load(g); resize(); draw(0);
  canvas.classList.add("is-on");
  sync();
  new ResizeObserver(() => { resize(); sync(); if (!running) draw((performance.now() - t0) / 1000); }).observe(canvas);
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("scroll", sync, { passive: true });
}).catch(() => {});   // no graph, no field: the page stands on its glow alone
})();
`;
