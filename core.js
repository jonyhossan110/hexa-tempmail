"use strict";
/* Hexa TempMail — shared core (extension pages + service worker).
   Plain script, no DOM assumptions except where guarded. */
const HTM_API = "https://api.mail.tm";

async function htmApi(method, path, token, body) {
  const opt = { method, headers: { "Accept": "application/json" } };
  if (token) opt.headers["Authorization"] = "Bearer " + token;
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(HTM_API + path, opt);
  let data = {};
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}
function htmAsList(d) { return Array.isArray(d) ? d : (d && d["hydra:member"]) || []; }

/* ---------- storage (chrome.storage.local with localStorage fallback) ---------- */
const htmStore = {
  async get(keys) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return await chrome.storage.local.get(keys);
    }
    const out = {};
    for (const k of keys) {
      try { const v = localStorage.getItem("htm_" + k); if (v !== null) out[k] = JSON.parse(v); } catch (e) {}
    }
    return out;
  },
  async set(obj) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return await chrome.storage.local.set(obj);
    }
    for (const k of Object.keys(obj)) {
      try { localStorage.setItem("htm_" + k, JSON.stringify(obj[k])); } catch (e) {}
    }
  }
};

/* ---------- token handling ---------- */
async function htmGetToken(acct) {
  const r = await htmApi("POST", "/token", null, { address: acct.address, password: acct.password });
  if (r.status === 200 && r.data.token) return r.data.token;
  throw new Error("login failed (" + r.status + ")");
}
const HTM_TOKEN_TRUST_MS = 10 * 60 * 1000;
async function htmAuth(acct, tokenCache) {
  // Cache entries are {t, at}; v1 stored plain strings — tolerate both.
  let entry = tokenCache[acct.address];
  if (typeof entry === "string") entry = { t: entry, at: 0 };
  if (entry && entry.t) {
    if (Date.now() - (entry.at || 0) < HTM_TOKEN_TRUST_MS) return entry.t;
    const me = await htmApi("GET", "/me", entry.t);
    if (me.status === 200) {
      tokenCache[acct.address] = { t: entry.t, at: Date.now() };
      return entry.t;
    }
    delete tokenCache[acct.address];
  }
  const t = await htmGetToken(acct);
  tokenCache[acct.address] = { t, at: Date.now() };
  return t;
}

/* ---------- OTP extraction (same logic as the CLI tool + web UI) ---------- */
const HTM_KEYWORD = /\b(code|otp|pin|passcode|one[\s-]?time|security\s+code|auth\w*\s+code)\b|verif\w*|confirm\w*/i;
function htmExtractOtps(text) {
  if (!text) return [];
  const scored = {};
  const pats = [
    { re: /\bG-(\d{6})\b/g, get: m => m[1] },
    { re: /\b(\d{3})[\s\-](\d{3})\b/g, get: m => m[1] + m[2] },
    { re: /\b(\d{4,8})\b/g, get: m => m[1] },
    { re: /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/g, get: m => m[1] },
    { re: /\b([A-Z0-9]{6,8})\b/g, get: m => m[1] },
  ];
  for (const p of pats) {
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const code = p.get(m);
      const start = Math.max(0, m.index - 80);
      const win = text.slice(start, m.index + m[0].length + 40);
      let s = 0;
      if (HTM_KEYWORD.test(win)) s += 10;
      if (/^\d{6}$/.test(code)) s += 5;
      else if (/^\d{4,8}$/.test(code)) s += 3;
      if (/^\d{4}$/.test(code) && +code >= 1900 && +code <= 2099) s -= 8;
      if (s > 0) scored[code] = Math.max(scored[code] || 0, s);
    }
  }
  return Object.keys(scored).sort((a, b) => scored[b] - scored[a]);
}

/* ---------- verification-link extraction (regex anchors — worker-safe) ---------- */
function htmExtractVerifyLink(full) {
  const cands = [];
  const push = (url, scoreTxt, penaltyTxt) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    url = url.replace(/&amp;/g, "&");
    if (/\.(png|jpe?g|gif|css|js|svg|ico)(\?|$)/i.test(url)) return;
    let s = 0;
    const both = (url + " " + (scoreTxt || "")).toLowerCase();
    if (/verif/.test(both)) s += 10;
    if (/confirm/.test(both)) s += 8;
    if (/activat/.test(both)) s += 8;
    if (/validat|complete.*(signup|registration)|set.*password/.test(both)) s += 5;
    if (/token|code=|key=/.test(url)) s += 3;
    const pen = (url + " " + (penaltyTxt || "")).toLowerCase();
    if (/unsubscribe|privacy|terms|facebook|twitter|instagram|linkedin/.test(pen)) s -= 20;
    cands.push({ url, s });
  };
  const htmls = Array.isArray(full.html) ? full.html.join("\n") : (full.html || "");
  if (htmls) {
    const aRe = /<a\s[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = aRe.exec(htmls)) !== null) {
      const txt = m[2].replace(/<[^>]+>/g, " ").trim();
      push(m[1], txt, txt);
    }
  }
  const text = full.text || "";
  const urlRe = /https?:\/\/[^\s<>"')\]]+/g;
  let m2;
  while ((m2 = urlRe.exec(text)) !== null) {
    const win = text.slice(Math.max(0, m2.index - 60), m2.index + m2[0].length + 20);
    push(m2[0], win, "");
  }
  cands.sort((a, b) => b.s - a.s);
  return (cands.length && cands[0].s > 0) ? cands[0].url : null;
}

/* Crude but safe HTML-to-text for reading HTML-only mail. */
function htmHtmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

/* Scan one full message -> {codes, link} */
function htmScanMessage(full) {
  const text = (full.subject || "") + "\n" + (full.text || "");
  return { codes: htmExtractOtps(text), link: htmExtractVerifyLink(full) };
}
