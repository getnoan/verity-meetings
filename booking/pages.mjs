/**
 * The booking pages: server-rendered shells plus one stylesheet and one small
 * script, all served from this process (the CSP allows nothing else). The
 * server embeds each page's data as JSON; app.js draws the calendar, the times
 * in the guest's own timezone, the form, and the confirmation.
 *
 * They wear a dark design system: the nebula ground and ivory type, condensed
 * uppercase headings with one lit word, glass cards, the readout buttons. The
 * optional site nav and footer are site-chrome.mjs. Display fonts are fetched
 * from BOOKING_FONT_ORIGIN and served same-origin by server.mjs; with no origin
 * set they 404 and the CSS falls back to the system stack, by design.
 *
 * Copy is written from the guest's side and in plain words. No em dashes: this
 * is external copy.
 */
import { createHash } from "node:crypto";
import { siteHeader, siteFooter } from "./site-chrome.mjs";
import { agentName } from "../agents/required-env.mjs";
import { FIELD_JS } from "./field.mjs";

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const json = obj => JSON.stringify(obj).replace(/</g, "\\u003c");

/** The site's font files, proxied by server.mjs at /assets/fonts/<name>. */
export const FONT_FILES = ["tusker-grotesk.woff2", "aktiv-grotesk-400.woff2", "aktiv-grotesk-500.woff2", "aktiv-grotesk-700.woff2"];

/** A heading with its last word lit, the site's "one lit word" (the subject of the line). */
export function lit(text) {
  const words = String(text || "").trim().split(/\s+/);
  const last = words.pop() || "";
  return `${words.length ? `${esc(words.join(" "))} ` : ""}<em>${esc(last)}</em>`;
}

/** The product-page hero band (the site's Hero with a field): her glow, the
 *  universe, a fade under the nav, and the dissolve into the ground. */
const heroBand = inner => `<section class="hero">
  <div class="hero-bg" aria-hidden="true">
    <div class="u-glow"></div>
    <canvas data-field></canvas>
    <div class="hero-top"></div>
    <div class="u-hero-dissolve"></div>
  </div>
  <div class="hero-in site-wrap">${inner}</div>
</section>`;

/** Whose pages these are, for link previews and the brief copy. COMPANY_NAME, the same
 *  variable the agents use; unset, the copy simply names nobody. */
const companyName = () => (process.env.COMPANY_NAME || "").trim();

/** Link-preview tags (Open Graph + Twitter) for a page. `share.origin` is the public URL
 *  (BOOKING_PUBLIC_URL): crawlers need absolute links. The card is a JPEG from booking/og/,
 *  served at /assets/og/<card>.jpg; without an origin the page simply has none, and with no
 *  card (`share.card` null: nothing in booking/og/) the image tags are left out rather than
 *  pointing at a 404. */
function shareTags(title, share) {
  if (!share?.origin) return "";
  const origin = String(share.origin).replace(/\/+$/, "");
  const company = companyName();
  const desc = share.description || (company ? `Book a meeting with ${company}.` : "Book a meeting.");
  const image = share.card === null ? null : `${origin}/assets/og/${share.card || "default"}.jpg`;
  return [
    `<meta name="description" content="${esc(desc)}">`,
    `<meta property="og:type" content="website">`,
    company ? `<meta property="og:site_name" content="${esc(company)}">` : "",
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    share.path ? `<meta property="og:url" content="${esc(origin + share.path)}">` : "",
    ...(image ? [
      `<meta property="og:image" content="${esc(image)}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:alt" content="${esc(title)}">`,
    ] : []),
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    image ? `<meta name="twitter:image" content="${esc(image)}">` : "",
  ].filter(Boolean).join("\n");
}

/** Icon links, only for the icons that exist. server.mjs calls setIconLinks() with what it
 *  found in booking/icons/ (a checkout may ship none); until then, all three, as before. */
const ALL_ICONS = new Set(["/assets/favicon-32.png", "/assets/favicon-192.png", "/apple-touch-icon.png"]);
let iconLinks = "";
export function setIconLinks(have = ALL_ICONS) {
  iconLinks = [
    have.has("/assets/favicon-32.png") ? `<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png?v=2">` : "",
    have.has("/assets/favicon-192.png") ? `<link rel="icon" type="image/png" sizes="192x192" href="/assets/favicon-192.png?v=2">` : "",
    have.has("/apple-touch-icon.png") ? `<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=2">` : "",
  ].filter(Boolean).join("\n");
}
setIconLinks();

function shell({ title, body, boot = null, hero = false, share = null }) {
  // The client script runs in the browser, where the server's helpers do not exist: anything
  // it shows about the agent or the company travels in the boot JSON.
  if (boot) boot = { agent: agentName(), company: companyName(), ...boot };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0a0b10">
<title>${esc(title)}</title>
${shareTags(title, share)}
<link rel="preload" href="/assets/fonts/tusker-grotesk.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/aktiv-grotesk-400.woff2" as="font" type="font/woff2" crossorigin>
${iconLinks}
<link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION}">
</head>
<body>
${siteHeader({ overlay: hero })}
${hero ? heroBand(body) : `<div class="page site-wrap">\n${body}\n</div>`}
${siteFooter()}
${boot ? `<script type="application/json" id="boot">${json(boot)}</script>\n` : ""}<script src="/assets/app.js?v=${ASSET_VERSION}" defer></script>
${hero ? `<script src="/assets/field.js?v=${ASSET_VERSION}" defer></script>` : ""}
</body>
</html>`;
}

const facts = t => `<ul class="facts"><li>${t.lengthMin} min</li><li>Google Meet</li></ul>`;

export function renderHost(data, share = null) {
  const cards = data.types.map(t => `
    <a class="type u-card" href="/${esc(t.handle)}/${esc(t.slug)}">
      <span class="type-name">${esc(t.name)}</span>
      <span class="type-len">${t.lengthMin} min · Google Meet</span>
      ${t.description ? `<span class="type-desc">${esc(t.description)}</span>` : ""}
      <span class="type-go" aria-hidden="true">▸ Pick a time</span>
    </a>`).join("");
  const first = String(data.hostName || "").split(/\s+/)[0];
  return shell({
    title: data.hostName ? `Book time with ${data.hostName}` : "Book a meeting",
    hero: true,
    share: share && { ...share, description: "Pick a meeting and a time that suits you." },
    body: `<main class="host">
  <p class="eyebrow">Book a meeting</p>
  <h1 class="font-display">${first ? `Book time with <em>${esc(first)}</em>` : lit("Pick a meeting")}</h1>
  <div class="types">${cards}</div>
</main>`,
  });
}

export function renderType(type, share = null) {
  return shell({
    title: `${type.name}${type.hostName ? ` with ${type.hostName}` : ""}`,
    boot: { mode: "book", type },
    hero: true,
    share: share && { ...share, description: type.description || `${type.lengthMin} minutes on Google Meet. Pick a time that suits you.` },
    body: `<main class="booking">
  <aside class="about">
    ${type.hostName ? `<p class="eyebrow">${esc(type.hostName)}</p>` : ""}
    <h1 class="font-display">${lit(type.name)}</h1>
    ${facts(type)}
    ${type.description ? `<p class="desc">${esc(type.description)}</p>` : ""}
  </aside>
  <section class="flow u-card" id="flow" aria-live="polite"><p class="muted">Loading times…</p></section>
</main>`,
  });
}

export function renderManage(view, token, share = null) {
  const t = view.type;
  return shell({
    title: t ? `Your ${t.name}` : "Your meeting",
    hero: true,
    share: share && { origin: share.origin, card: share.card, description: "Reschedule or cancel your meeting." },   // no og:url: the link carries the manage token
    boot: { mode: "manage", view, token, type: t ? { ...t, questions: [], timeZone: view.timeZone } : null },
    body: `<main class="booking">
  <aside class="about">
    ${t?.hostName ? `<p class="eyebrow">${esc(t.hostName)}</p>` : ""}
    <h1 class="font-display">${lit(t ? t.name : "Your meeting")}</h1>
    ${t ? facts(t) : ""}
  </aside>
  <section class="flow u-card" id="flow" aria-live="polite"><p class="muted">Loading your meeting…</p></section>
</main>`,
  });
}

export function renderMessage(title, text, { status = "", share = null } = {}) {
  return shell({
    title,
    share: share && { origin: share.origin, description: text },
    body: `<main class="host">${status ? `<p class="eyebrow">${esc(status)}</p>` : ""}<h1 class="font-display">${lit(title)}</h1><p class="desc">${esc(text)}</p></main>`,
  });
}

export const APP_CSS = `
@font-face{font-family:"Tusker Grotesk";src:url("/assets/fonts/tusker-grotesk.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:"Aktiv Grotesk";src:url("/assets/fonts/aktiv-grotesk-400.woff2") format("woff2");font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:"Aktiv Grotesk";src:url("/assets/fonts/aktiv-grotesk-500.woff2") format("woff2");font-weight:500;font-style:normal;font-display:swap}
@font-face{font-family:"Aktiv Grotesk";src:url("/assets/fonts/aktiv-grotesk-700.woff2") format("woff2");font-weight:700;font-style:normal;font-display:swap}
:root{
  --ground:#0a0b10;--surface:#111319;--ink:#ece9e2;--ivory:236 233 226;--teal:94 232 192;--lit-rgb:254 134 71;
  --primary:#fe8647;--muted:rgb(var(--ivory) / .6);--faint:rgb(var(--ivory) / .45);--rule:rgb(var(--ivory) / .07);--hair:rgb(var(--ivory) / .12);
  --bad:#ff8a7a;--radius:.75rem;
  --font-display:"Tusker Grotesk","Aktiv Grotesk",system-ui,sans-serif;--font-sans:"Aktiv Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;
  --font-mono:"SF Mono",ui-monospace,Menlo,monospace;
  color-scheme:dark;
}
*{box-sizing:border-box;border-color:var(--rule)}
[hidden]{display:none!important}
html{background:var(--ground)}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;color:var(--ink);font:16px/1.55 var(--font-sans);-webkit-font-smoothing:antialiased;text-wrap:pretty;
  background:radial-gradient(70% 45% at 78% -8%,rgb(var(--lit-rgb) / .07),transparent 62%),radial-gradient(55% 38% at 8% 0%,rgb(var(--teal) / .05),transparent 60%),var(--ground)}
a{color:inherit}
p{margin:0}
h1,h2{margin:0}
.site-wrap{width:100%;max-width:80rem;margin-inline:auto;padding-inline:24px}
.font-display{font-family:var(--font-display);text-transform:uppercase;letter-spacing:-.01em;text-wrap:balance;font-weight:400}
.font-display em{font-style:normal;color:var(--primary);text-shadow:0 0 22px rgb(var(--lit-rgb) / .35)}
h1.font-display{font-size:clamp(2.25rem,1.75rem + 2.5vw,3.75rem);line-height:1.02}
.hero h1.font-display{font-size:clamp(2.75rem,1.6rem + 4.2vw,5.25rem);line-height:1;letter-spacing:-.015em}
.eyebrow{font-size:.75rem;text-transform:uppercase;letter-spacing:.2em;color:var(--muted)}
.muted{color:var(--muted)}
.desc{color:var(--muted);max-width:52ch;white-space:pre-line}

/* header (site Header.tsx) */
.site-header{position:sticky;top:0;z-index:50;background:rgb(var(--ivory) / 0);background:color-mix(in srgb,var(--ground) 70%,transparent);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-bottom:1px solid var(--rule)}
.site-bar{max-width:80rem;margin-inline:auto;padding-inline:24px;height:64px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.site-logo{display:flex;align-items:center;color:var(--ink)}
.site-logo svg{height:28px;width:auto}
.site-nav{display:flex;align-items:center;gap:28px;font-size:14px;color:rgb(var(--ivory) / .8)}
.nav-menu{position:relative}
.nav-trigger{display:flex;align-items:center;gap:4px;padding:8px 0;background:none;border:0;color:inherit;font:inherit;cursor:pointer}
.nav-trigger:hover,.nav-top:hover{color:var(--ink)}
.nav-chev{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s}
.nav-top{text-decoration:none}
.nav-panel{position:absolute;left:0;top:100%;padding-top:8px;opacity:0;visibility:hidden;transition:opacity .15s}
.nav-menu:hover .nav-panel,.nav-menu:focus-within .nav-panel{opacity:1;visibility:visible}
.nav-panel-in{min-width:200px;border:1px solid var(--rule);border-radius:.75rem;padding:8px;background:color-mix(in srgb,var(--ground) 95%,transparent);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 10px 30px rgb(0 0 0 / .35)}
.nav-panel-in.two{min-width:380px;display:grid;grid-template-columns:1fr 1fr;gap:4px}
.nav-group-h{padding:8px 12px 4px;font-size:10px;text-transform:uppercase;letter-spacing:.18em;color:var(--faint)}
.nav-link{display:flex;align-items:center;border-radius:6px;padding:8px 12px;font-size:14px;text-decoration:none;color:rgb(var(--ivory) / .8)}
.nav-link:hover{background:rgb(255 255 255 / .05);color:var(--ink)}
.nav-pill{margin-left:6px;border-radius:999px;background:rgb(var(--lit-rgb) / .15);padding:1px 6px;font-size:10px;font-weight:500;color:var(--primary)}
.site-actions{display:flex;align-items:center;gap:12px}
.site-login{font-size:14px;text-decoration:none}
.site-burger{display:none;align-items:center;justify-content:center;width:44px;height:44px;border-radius:6px;border:0;background:none;color:var(--ink);cursor:pointer}
.site-burger:hover{background:rgb(255 255 255 / .05)}
.site-burger svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.site-burger .i-close,.site-burger[aria-expanded="true"] .i-open{display:none}
.site-burger[aria-expanded="true"] .i-close{display:block}
.site-mnav{border-top:1px solid var(--rule);background:color-mix(in srgb,var(--ground) 95%,transparent);max-height:calc(100vh - 64px);max-height:calc(100dvh - 64px);overflow-y:auto}
.site-mnav nav{max-width:80rem;margin-inline:auto;padding:16px 24px;display:flex;flex-direction:column;gap:4px;color:rgb(var(--ivory) / .8)}
.mnav-trigger,.mnav-top{display:flex;align-items:center;justify-content:space-between;min-height:44px;padding:10px 12px;border-radius:6px;background:none;border:0;color:inherit;font:inherit;font-size:16px;text-align:left;text-decoration:none;cursor:pointer}
.mnav-trigger:hover,.mnav-top:hover{background:rgb(255 255 255 / .05)}
.mnav-trigger[aria-expanded="true"] .nav-chev{transform:rotate(180deg)}
.mnav-links{margin-left:12px;padding-left:12px;border-left:1px solid var(--rule);display:flex;flex-direction:column;gap:2px}
.mnav-link{display:flex;align-items:center;min-height:44px;padding:8px 12px;border-radius:6px;font-size:14px;text-decoration:none}
.mnav-link:hover{background:rgb(255 255 255 / .05)}
.mnav-cta{margin-top:10px;align-self:flex-start}
@media (max-width:767px){.site-nav,.site-actions .site-cta{display:none}.site-burger{display:inline-flex}}
@media (max-width:639px){.site-actions .site-login{display:none}}

/* the header overlays a hero, as on the product pages */
.site-header.is-overlay{position:absolute;inset-inline:0;top:0;background:transparent;border-bottom-color:transparent;-webkit-backdrop-filter:none;backdrop-filter:none}

/* the product-page hero (site kit Hero with a field): glow, the universe, the nav fade, the dissolve */
.hero{position:relative;isolation:isolate;overflow:hidden;min-height:560px;display:flex;flex-direction:column;justify-content:center}
@media (min-width:768px){.hero{min-height:680px}}
.hero-bg{position:absolute;inset:0;z-index:-1;pointer-events:none}
.u-glow{position:absolute;inset:0;background:linear-gradient(to bottom,rgb(10 11 16 / .9) 0%,transparent 110px),radial-gradient(60% 55% at 50% 0%,rgb(var(--teal) / .2),transparent 70%),radial-gradient(40% 45% at 92% 100%,rgb(var(--lit-rgb) / .08),transparent 70%)}
.hero-bg canvas{position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity 1.2s ease}
.hero-bg canvas.is-on{opacity:1}
.hero-top{position:absolute;inset-inline:0;top:0;height:112px;background:linear-gradient(to bottom,var(--ground),transparent)}
.u-hero-dissolve{position:absolute;left:0;right:0;bottom:0;height:42%;background:linear-gradient(to top,var(--ground) 0%,rgb(10 11 16 / .92) 18%,rgb(10 11 16 / .65) 45%,rgb(10 11 16 / .25) 75%,transparent 100%)}
.hero-in{padding-block:128px 80px}
@media (min-width:768px){.hero-in{padding-top:160px}}
/* glass on the field: the field reads through it, quieter (the site's crossing rule) */
.hero .u-card{background:rgb(10 11 16 / .5);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.hero .type.u-card{background:rgb(10 11 16 / .45)}
.hero .about .desc{font-size:1.125rem;line-height:1.65;color:rgb(var(--ivory) / .7)}

/* readout buttons (site kit Button, u-btn) */
.u-btn{position:relative;display:inline-flex;align-items:center;gap:9px;border-radius:6px;border:1px solid transparent;background:none;font:500 12px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;text-decoration:none;white-space:nowrap;cursor:pointer;color:var(--ink);transition:background-color .25s,border-color .25s,color .25s,box-shadow .25s}
.u-btn:focus-visible{outline:2px solid rgb(var(--teal) / .7);outline-offset:3px}
.u-btn:disabled{pointer-events:none;opacity:.5}
.u-btn[data-glyph]::before{content:attr(data-glyph);color:#5eead4;transition:color .25s}
.u-btn-md{padding:12px 18px;min-height:44px}
.u-btn-sm{padding:9px 14px;font-size:11px}
.u-btn-primary{border-color:rgb(var(--lit-rgb) / .6);background:rgb(var(--lit-rgb) / .07);color:#ffb48a}
.u-btn-primary::before{color:var(--primary)}
.u-btn-primary:hover{background:var(--primary);border-color:var(--primary);color:#1a0d05;box-shadow:0 0 28px rgb(var(--lit-rgb) / .28)}
.u-btn-primary:hover::before{color:#1a0d05}
.u-btn-ghost{padding-inline:4px;color:rgb(var(--ivory) / .7)}
.u-btn-ghost:hover{color:var(--ink)}
.u-btn-danger{border-color:rgb(255 138 122 / .45);color:var(--bad)}
.u-btn-danger:hover{background:rgb(255 138 122 / .1);border-color:var(--bad)}

/* glass (site u-card) */
.u-card{position:relative;border-radius:1rem;background:rgb(var(--ivory) / .04);border:1px solid rgb(var(--ivory) / .09);box-shadow:inset 1px 1px 0 rgb(var(--teal) / .22),inset 0 0 36px rgb(var(--teal) / .035);transition:border-color .35s,box-shadow .35s,background-color .35s}

/* page */
.page{flex:1;display:flex;flex-direction:column;padding-block:calc(64px + clamp(3rem,2.43rem + 2.86vw,5rem)) clamp(3rem,2.43rem + 2.86vw,5rem)}
.host{display:grid;gap:18px}
.types{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));margin-top:18px}
.type{display:grid;gap:6px;padding:22px 24px;text-decoration:none}
.type:hover{border-color:rgb(var(--teal) / .32);box-shadow:inset 1px 1px 0 rgb(var(--teal) / .5),inset 0 0 36px rgb(var(--teal) / .08),0 0 40px rgb(var(--teal) / .1)}
.type-name{font-family:var(--font-display);text-transform:uppercase;font-size:1.6rem;line-height:1.05}
.type-len{font:500 11px/1.6 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
.type-desc{font-size:.95rem;color:var(--muted)}
.type-go{margin-top:8px;font:500 11px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:#ffb48a}
.booking{display:grid;grid-template-columns:minmax(260px,400px) 1fr;gap:clamp(24px,4vw,56px);align-items:start}
@media (max-width:860px){.booking{grid-template-columns:1fr}}
.about{display:grid;gap:16px;padding-top:6px}
.facts{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.facts li{font:500 11px/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;padding:8px 10px;border:1px solid var(--hair);border-radius:6px;color:rgb(var(--ivory) / .8)}
.flow{padding:clamp(18px,3vw,28px);display:grid;gap:20px;min-height:340px}
.pick{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:26px}
@media (max-width:640px){.pick{grid-template-columns:1fr}}
.cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.flow h2{font:500 12px/1.4 var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:rgb(var(--ivory) / .8)}
.nav{display:flex;gap:6px}
button{font:inherit;cursor:pointer}
.icon{width:40px;height:40px;border-radius:6px;border:1px solid var(--hair);background:transparent;color:var(--ink);font-size:18px}
.icon:hover:not(:disabled){border-color:rgb(var(--teal) / .5)}
.icon:disabled{opacity:.3;cursor:default}
.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center}
.dow{font:500 10px/1 var(--font-mono);color:var(--faint);padding:6px 0 8px;letter-spacing:.12em}
.day{aspect-ratio:1;max-width:100%;min-height:40px;border:1px solid transparent;border-radius:8px;background:transparent;color:rgb(var(--ivory) / .28);font-variant-numeric:tabular-nums}
.day.open{border-color:rgb(var(--teal) / .22);background:rgb(var(--teal) / .05);color:var(--ink);font-weight:500}
.day.open:hover{border-color:rgb(var(--teal) / .6)}
.day.sel{background:var(--primary);border-color:var(--primary);color:#1a0d05;box-shadow:0 0 24px rgb(var(--lit-rgb) / .3)}
.day:disabled{cursor:default}
.times{display:grid;gap:8px;align-content:start;max-height:400px;overflow:auto;padding-right:2px}
.slot{padding:12px;border:1px solid var(--hair);border-radius:6px;background:transparent;color:var(--ink);font:500 13px/1 var(--font-mono);letter-spacing:.08em;font-variant-numeric:tabular-nums;min-height:44px;transition:border-color .2s,box-shadow .2s,color .2s}
.slot:hover{border-color:rgb(var(--lit-rgb) / .7);color:#ffb48a;box-shadow:0 0 20px rgb(var(--lit-rgb) / .15)}
.pick-wrap{display:grid;gap:24px}
.tz{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding-top:18px;border-top:1px solid var(--rule);font-size:.85rem;color:var(--muted)}
select,input,textarea{font:inherit;color:var(--ink);background:rgb(var(--ivory) / .03);border:1px solid var(--hair);border-radius:8px;padding:11px 12px;width:100%}
select option{background:var(--surface);color:var(--ink)}
.tz select{width:auto;max-width:100%;padding:6px 8px}
textarea{min-height:104px;resize:vertical}
input:focus,select:focus,textarea:focus,button:focus-visible,a:focus-visible{outline:2px solid rgb(var(--teal) / .7);outline-offset:2px}
form{display:grid;gap:16px;max-width:560px}
label{display:grid;gap:7px;font-size:.92rem;font-weight:500}
.req{color:var(--faint);font-weight:400}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.brief{position:relative;display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:start;padding:14px 16px;border:1px solid rgb(var(--teal) / .25);border-radius:10px;background:rgb(var(--teal) / .04);cursor:pointer;font-weight:400}
.brief input{position:absolute;opacity:0;width:44px;height:26px;margin:0;cursor:pointer}
.brief-knob{position:relative;width:44px;height:26px;border-radius:999px;background:rgb(var(--ivory) / .12);border:1px solid var(--hair);transition:background-color .2s,border-color .2s;flex:none}
.brief-knob::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--ink);transition:transform .2s}
.brief input:checked + .brief-knob{background:#5eead4;border-color:#5eead4}
.brief input:checked + .brief-knob::after{transform:translateX(18px);background:#0e1413}
.brief input:focus-visible + .brief-knob{outline:2px solid rgb(var(--teal) / .7);outline-offset:2px}
.brief-text{display:grid;gap:4px}
.brief-title{font-weight:500}
.brief-what{font-size:.88rem;color:var(--muted);line-height:1.5}
.brief.is-off{cursor:default;opacity:.6;border-color:var(--hair);background:transparent}
.brief-note{padding:12px 14px;border-radius:8px;border:1px solid rgb(var(--teal) / .3);background:rgb(var(--teal) / .05);color:rgb(var(--ivory) / .85)}
.chosen{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;justify-content:space-between;padding:12px 14px;border-radius:8px;border:1px solid rgb(var(--lit-rgb) / .35);background:rgb(var(--lit-rgb) / .06)}
.link{background:none;border:0;padding:0;color:#ffb48a;text-decoration:underline;text-underline-offset:3px}
.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.err{color:var(--bad);font-size:.92rem}
.done{display:grid;gap:14px;max-width:560px}
.done .eyebrow{font:500 11px/1 var(--font-mono);letter-spacing:.16em;color:#5eead4}
.done .when{font-family:var(--font-display);text-transform:uppercase;font-size:clamp(1.6rem,1.3rem + 1.4vw,2.2rem);line-height:1.05}
.done a{color:#ffb48a;text-underline-offset:3px}
.empty{color:var(--muted);font-size:.92rem}

/* footer (site Footer.tsx) */
.site-footer{border-top:1px solid var(--rule);background:var(--ground)}
.foot-grid{display:grid;gap:40px;padding-top:56px}
@media (min-width:1024px){.foot-grid{grid-template-columns:3fr 9fr;gap:32px}}
.foot-logo{display:inline-flex;color:var(--ink)}
.foot-logo svg{height:32px;width:auto}
.foot-brand p{margin-top:20px;max-width:20rem;font-size:13px;line-height:1.6;color:rgb(var(--ivory) / .6)}
.foot-socials{margin-top:24px;display:flex;gap:12px}
.foot-social{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:999px;border:1px solid var(--rule);color:rgb(var(--ivory) / .7)}
.foot-social:hover{color:var(--ink);border-color:rgb(var(--ivory) / .4)}
.foot-social svg{width:16px;height:16px}
.foot-cols{display:grid;grid-template-columns:repeat(2,1fr);gap:32px}
@media (min-width:640px){.foot-cols{grid-template-columns:repeat(3,1fr)}}
@media (min-width:1024px){.foot-cols{grid-template-columns:repeat(5,1fr);gap:24px}}
.foot-h{margin-bottom:12px;font-size:11px;text-transform:uppercase;letter-spacing:.18em;color:rgb(var(--ivory) / .5)}
.foot-link{display:block;padding:4px 0;font-size:13px;color:rgb(var(--ivory) / .7);text-decoration:none;transition:color .2s}
.foot-link:hover{color:var(--ink)}
.foot-base{margin-top:48px;padding-block:24px 40px;border-top:1px solid var(--rule);display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;font-size:12px;color:rgb(var(--ivory) / .5)}
.foot-base a{text-decoration:none}
.foot-base a:hover{color:var(--ink)}

@media (max-width:420px){.site-wrap,.site-bar{padding-inline:16px}.flow{padding:14px}.grid{gap:2px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

export const APP_JS = `(() => {
"use strict";
/* the site's mobile nav: menu button, accordion sections, closes on a link tap or on widening */
(function wireNav() {
  const burger = document.querySelector(".site-burger"), panel = document.getElementById("site-mnav");
  if (!burger || !panel) return;
  const set = open => {
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    panel.hidden = !open;
    document.body.style.overflow = open ? "hidden" : "";
  };
  burger.addEventListener("click", () => set(panel.hidden));
  panel.querySelectorAll(".mnav-trigger").forEach(b => b.addEventListener("click", () => {
    const open = b.getAttribute("aria-expanded") !== "true";
    b.setAttribute("aria-expanded", String(open));
    document.getElementById(b.getAttribute("aria-controls")).hidden = !open;
  }));
  panel.querySelectorAll("a").forEach(a => a.addEventListener("click", () => set(false)));
  window.matchMedia("(min-width: 768px)").addEventListener("change", e => { if (e.matches) set(false); });
})();
const bootEl = document.getElementById("boot");
if (!bootEl) return;
const boot = JSON.parse(bootEl.textContent);
const flow = document.getElementById("flow");
const type = boot.type;
const guessTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
let tz = guessTz;
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};
/* replaceChildren with the same null-skipping as el() */
const put = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter(c => c != null && c !== false));
const fmt = (iso, opts) => new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }).format(new Date(iso));
const dayKey = iso => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const timeOf = iso => fmt(iso, { hour: "numeric", minute: "2-digit" });
const longWhen = (s, e) => fmt(s, { weekday: "long", day: "numeric", month: "long" }) + ", " + timeOf(s) + " to " + timeOf(e);
async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Something went wrong. Try again.");
  return data;
}
const monthId = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
const cache = new Map();
async function monthSlots(id) {
  if (!cache.has(id)) cache.set(id, api("/api/month?" + new URLSearchParams({ handle: type.handle, slug: type.slug, month: id, ...(boot.token ? { token: boot.token } : {}) })).catch(e => { cache.delete(id); throw e; }));
  return (await cache.get(id)).slots;
}

function tzPicker(onChange) {
  let zones = [];
  try { zones = Intl.supportedValuesOf("timeZone"); } catch { zones = [guessTz]; }
  if (!zones.includes(tz)) zones.unshift(tz);
  const sel = el("select", { id: "tz", "aria-label": "Time zone", on: { change: e => { tz = e.target.value; onChange(); } } },
    zones.map(z => el("option", { value: z, selected: z === tz, text: z.replace(/_/g, " ") })));
  return el("div", { class: "tz" }, "Times shown in ", sel);
}

/* ---------- the picker: month grid + times for the chosen day ---------- */
function picker({ onPick, heading }) {
  let view = new Date(); view.setDate(1);
  const first = monthId(new Date());
  let selected = null, slots = [], err = null, loading = true;
  const root = el("div", { class: "pick-wrap" });
  async function load() {
    loading = true; draw();
    try { err = null; slots = await monthSlots(monthId(view)); }
    catch (e) { err = e.message; slots = []; }
    loading = false;
    const days = byDay();
    if (!selected || !days.has(selected)) selected = [...days.keys()].sort()[0] || null;
    draw();
  }
  function byDay() {
    const m = new Map();
    for (const s of slots) { const k = dayKey(s.startISO); if (!m.has(k)) m.set(k, []); m.get(k).push(s); }
    return m;
  }
  function draw() {
    const days = byDay();
    const y = view.getFullYear(), mo = view.getMonth();
    const lead = (new Date(y, mo, 1).getDay() + 6) % 7;
    const count = new Date(y, mo + 1, 0).getDate();
    const cells = [];
    for (const d of ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]) cells.push(el("div", { class: "dow", "aria-hidden": "true", text: d }));
    for (let i = 0; i < lead; i++) cells.push(el("div"));
    for (let d = 1; d <= count; d++) {
      const key = y + "-" + String(mo + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      const open = days.has(key);
      cells.push(el("button", { type: "button", class: "day" + (open ? " open" : "") + (key === selected ? " sel" : ""), disabled: !open,
        "aria-label": new Date(y, mo, d).toDateString() + (open ? ", times available" : ", no times"), "aria-pressed": key === selected ? "true" : null,
        on: { click: () => { selected = key; draw(); } } }, String(d)));
    }
    const label = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(view);
    const times = selected && days.get(selected) || [];
    put(root, 
      heading ? el("h2", { text: heading }) : null,
      el("div", { class: "pick" },
        el("div", {},
          el("div", { class: "cal-head" }, el("h2", { text: label }),
            el("div", { class: "nav" },
              el("button", { type: "button", class: "icon", "aria-label": "Previous month", disabled: monthId(view) <= first, on: { click: () => { view.setMonth(view.getMonth() - 1); load(); } } }, "‹"),
              el("button", { type: "button", class: "icon", "aria-label": "Next month", on: { click: () => { view.setMonth(view.getMonth() + 1); load(); } } }, "›"))),
          el("div", { class: "grid" }, cells)),
        el("div", { class: "times" },
          loading ? el("p", { class: "empty", text: "Finding times…" })
          : err ? el("p", { class: "err", text: err })
          : !selected ? el("p", { class: "empty", text: "No open times this month. Try the next one." })
          : [el("h2", { text: fmt(times[0].startISO, { weekday: "long", day: "numeric", month: "long" }) }),
             times.map(s => el("button", { type: "button", class: "slot", on: { click: () => onPick(s) } }, timeOf(s.startISO)))])),
      tzPicker(() => { selected = null; load(); }));
  }
  load();
  return root;
}

/* ---------- "brief me before the call" ---------- */
function briefSwitch(slot) {
  const b = type.brief;
  if (!b) return null;
  const tooSoon = new Date(slot.startISO) - Date.now() < b.minLeadMin * 60e3;
  const us = boot.company || "us";
  const what = b.variant === "investor"
    ? boot.agent + " will look at your fund and send you a short brief on " + us + ", the vision, and where it could fit your portfolio. Reply with anything you'd like to go deeper on before we speak."
    : boot.agent + " will look at your website and send you a short brief on how " + us + " could help. Reply with your questions and get answers before we speak.";
  return el("label", { class: "brief" + (tooSoon ? " is-off" : ""), for: "brief" },
    el("input", { type: "checkbox", id: "brief", name: "brief", role: "switch", disabled: tooSoon }),
    el("span", { class: "brief-knob", "aria-hidden": "true" }),
    el("span", { class: "brief-text" },
      el("span", { class: "brief-title", text: "Brief me before the call" }),
      el("span", { class: "brief-what", text: tooSoon ? "Briefs need at least " + (b.minLeadMin >= 120 ? Math.round(b.minLeadMin / 60) + " hours" : "an hour") + " before the call. Pick a later time to get one." : what })));
}

/* ---------- booking ---------- */
function bookFlow() {
  const showPick = () => put(flow, picker({ onPick: showForm }));
  function showForm(slot) {
    const errBox = el("p", { class: "err", role: "alert" });
    const fields = type.questions.map((q, i) => {
      const id = "q" + i;
      const input = q.input === "textarea" ? el("textarea", { id, name: id, required: q.required, maxlength: "500" })
        : el("input", { id, name: id, type: q.input, required: q.required, maxlength: "500", autocomplete: q.input === "tel" ? "tel" : q.input === "url" ? "url" : null });
      return el("label", { for: id }, el("span", {}, q.label, q.required ? null : el("span", { class: "req", text: " (optional)" })), input);
    });
    const submit = el("button", { type: "submit", class: "u-btn u-btn-primary u-btn-md", "data-glyph": "▸", text: "Book it" });
    const form = el("form", { on: { submit: async e => {
      e.preventDefault(); errBox.textContent = ""; submit.disabled = true; submit.textContent = "Booking…";
      const fd = new FormData(form);
      const answers = {}; type.questions.forEach((q, i) => { answers[i] = fd.get("q" + i) || ""; });
      try {
        const out = await api("/api/book", { handle: type.handle, slug: type.slug, startISO: slot.startISO, name: fd.get("name"), email: fd.get("email"), answers, website_url: fd.get("website_url") || "", brief: fd.get("brief") === "on" });
        showDone(out);
      } catch (err) { errBox.textContent = err.message; submit.disabled = false; submit.textContent = "Book it"; if (/no longer available|just taken/.test(err.message)) cache.clear(); }
    } } },
      el("div", { class: "chosen" }, el("span", { class: "when", text: longWhen(slot.startISO, slot.endISO) }), el("button", { type: "button", class: "link", on: { click: showPick }, text: "Change time" })),
      el("label", { for: "name" }, "Your name", el("input", { id: "name", name: "name", required: true, maxlength: "120", autocomplete: "name" })),
      el("label", { for: "email" }, "Email", el("input", { id: "email", name: "email", type: "email", required: true, maxlength: "254", autocomplete: "email" })),
      fields,
      briefSwitch(slot),
      el("div", { class: "hp", "aria-hidden": "true" }, el("label", { for: "website_url" }, "Leave this empty", el("input", { id: "website_url", name: "website_url", tabindex: "-1", autocomplete: "off" }))),
      errBox, submit);
    put(flow, form);
    form.querySelector("#name").focus();
  }
  function showDone(out) {
    put(flow, el("div", { class: "done" },
      el("p", { class: "eyebrow", text: "Booked" }),
      el("p", { class: "when", text: longWhen(out.startISO, out.endISO) }),
      el("p", { class: "muted", text: out.meetingUrl ? "A calendar invite with the Google Meet link is on its way to your inbox." : "A confirmation is on its way to your inbox." }),
      out.brief === "requested" ? el("p", { class: "brief-note", text: boot.agent + " is putting your brief together. It'll be in your inbox shortly, and you can reply to it with anything you'd like to cover." }) : null,
      out.meetingUrl ? el("p", {}, el("a", { href: out.meetingUrl, rel: "noopener", text: "Google Meet link" })) : null,
      el("p", { class: "muted" }, "Need to change it? ", el("a", { href: out.manageUrl, text: "Reschedule or cancel" }), ". Keep this link: it's the only way in.")));
  }
  showPick();
}

/* ---------- manage ---------- */
function manageFlow() {
  let v = boot.view;
  function show() {
    if (v.status === "cancelled") {
      put(flow, el("div", { class: "done" }, el("p", { class: "eyebrow", text: "Cancelled" }),
        el("p", { class: "when", text: longWhen(v.startISO, v.endISO) }),
        el("p", { class: "muted", text: "This meeting is cancelled." }),
        type ? el("p", {}, el("a", { href: "/" + type.handle + "/" + type.slug, text: "Book a new time" })) : null));
      return;
    }
    const past = new Date(v.endISO) < new Date();
    put(flow, el("div", { class: "done" },
      el("p", { class: "eyebrow", text: past ? "Happened" : "Booked" }),
      el("p", { class: "when", text: longWhen(v.startISO, v.endISO) }),
      el("p", { class: "muted", text: "Times shown in " + tz.replace(/_/g, " ") + "." }),
      v.meetingUrl ? el("p", {}, el("a", { href: v.meetingUrl, rel: "noopener", text: "Google Meet link" })) : null,
      past || !type ? null : el("div", { class: "actions" },
        el("button", { type: "button", class: "u-btn u-btn-primary u-btn-md", "data-glyph": "▸", on: { click: reschedule }, text: "Reschedule" }),
        el("button", { type: "button", class: "u-btn u-btn-danger u-btn-md", on: { click: cancelForm }, text: "Cancel meeting" }))));
  }
  function reschedule() {
    const errBox = el("p", { class: "err", role: "alert" });
    put(flow, 
      el("div", { class: "chosen" }, el("span", { text: "Moving: " + longWhen(v.startISO, v.endISO) }), el("button", { type: "button", class: "link", on: { click: show }, text: "Keep this time" })),
      picker({ heading: "Pick a new time", onPick: async slot => {
        errBox.textContent = "";
        try { v = await api("/api/manage/reschedule", { token: boot.token, startISO: slot.startISO }); cache.clear(); show(); }
        catch (e) { errBox.textContent = e.message; cache.clear(); }
      } }), errBox);
  }
  function cancelForm() {
    const errBox = el("p", { class: "err", role: "alert" });
    const go = el("button", { type: "submit", class: "u-btn u-btn-danger u-btn-md", text: "Cancel meeting" });
    const form = el("form", { on: { submit: async e => {
      e.preventDefault(); go.disabled = true;
      try { v = await api("/api/manage/cancel", { token: boot.token, reason: new FormData(form).get("reason") || "" }); show(); }
      catch (err) { errBox.textContent = err.message; go.disabled = false; }
    } } },
      el("p", { class: "when", text: longWhen(v.startISO, v.endISO) }),
      el("label", { for: "reason" }, el("span", {}, "Anything you'd like to say?", el("span", { class: "req", text: " (optional)" })), el("textarea", { id: "reason", name: "reason", maxlength: "500" })),
      errBox, el("div", { class: "actions" }, go, el("button", { type: "button", class: "u-btn u-btn-ghost u-btn-md", on: { click: show }, text: "Keep the meeting" })));
    put(flow, form);
  }
  show();
}

if (boot.mode === "book") bookFlow(); else manageFlow();
})();
`;

/** Content hash for the asset URLs: a deploy that changes either file changes the URL, so no browser runs stale code. */
export const ASSET_VERSION = createHash("sha256").update(APP_CSS).update(APP_JS).update(FIELD_JS).digest("hex").slice(0, 10);
export { FIELD_JS };
