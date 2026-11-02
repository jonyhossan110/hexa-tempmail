"use strict";
/* Hexa TempMail — UI logic for popup.html and page.html (shared). */
const $ = id => document.getElementById(id);
let accounts = [];
let current = null;
let tokenCache = {};
let settings = { autoCopy: true, soundOn: true, autoRef: true };
let scanned = {};
let latestOtp = null;
let latestLink = null;
let announcedOtpKey = "";
let currentMsgId = null;
let timer = null;
let dismissedAlertTs = 0;
let otpHistory = [];
let countsCache = {};
let domainsCache = [];
let lastMsgs = [];
let scanAttempts = {};

async function persist() {
  await htmStore.set({ accounts, current, tokens: tokenCache, settings, dismissedAlertTs });
}

/* ---------- helpers ---------- */
function setStatus(t, cls) { const s = $("status"); s.textContent = t || ""; s.className = cls || "dim"; }
function copyText(t, btn) {
  const done = () => { if (btn) { const o = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => btn.textContent = o, 1200); } };
  const fallback = () => {
    const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta);
    ta.select(); try { document.execCommand("copy"); done(); } catch (e) {} ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done).catch(fallback);
  else fallback();
}
function silentCopy(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(() => {});
}
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
    const ctx = beep._ctx || (beep._ctx = new Ctx());
    if (ctx.state === "suspended") ctx.resume();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.12, ctx.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.16 + 0.15);
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.16);
    });
  } catch (e) {}
}
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
function acct() { return accounts.find(a => a.address === current) || null; }

function onOtpFound(code, from, subject, msgId, forAddress, announce) {
  latestOtp = { code, from, subject, id: msgId, address: forAddress || current };
  showOtp();
  const addr = forAddress || current;
  const dup = otpHistory.some(h => h.code === code && h.address === addr &&
    (Date.now() - h.ts) < 15 * 60 * 1000);
  if (!dup) {
    otpHistory.unshift({ code, address: addr, label: (accounts.find(a => a.address === addr) || {}).label || "",
      from, subject, ts: Date.now() });
    otpHistory = otpHistory.slice(0, 10);
    htmStore.set({ otpHistory });
    renderHistory();
  }
  const key = (msgId || "") + ":" + code;
  if (announce !== false && key !== announcedOtpKey) {
    announcedOtpKey = key;
    if (settings.autoCopy) silentCopy(code);
    if (settings.soundOn) beep();
  }
}
function showOtp() {
  if (!latestOtp) return;
  $("otpBox").style.display = "block";
  $("otpCode").textContent = latestOtp.code;
  $("otpFrom").textContent = "for " + (latestOtp.address || "") + " — from " + latestOtp.from + " — " + latestOtp.subject;
}
function renderHistory() {
  const box = $("histList"); if (!box) return;
  if (!otpHistory.length) { box.innerHTML = "<span class='dim'>No codes yet.</span>"; return; }
  box.innerHTML = "";
  for (const h of otpHistory) {
    const div = document.createElement("div");
    div.className = "hist";
    const when = new Date(h.ts).toLocaleString();
    div.innerHTML = "<span class='hc'>" + esc(h.code) + "</span>" +
      "<span class='hm'>" + esc(h.address || "") + " — " + esc(h.from || "") +
      "<br><span class='dim'>" + esc(when) + " · " + esc(h.subject || "") + "</span></span>" +
      "<button class='ghost'>Copy</button>";
    div.querySelector("button").onclick = e => copyText(h.code, e.target);
    box.appendChild(div);
  }
}
function onLinkFound(url, from, subject) {
  latestLink = { url, from, subject };
  $("linkBox").style.display = "block";
  $("linkUrl").textContent = url;
  $("linkOpen").href = url;
  $("linkFrom").textContent = "from " + from + " — " + subject;
}

/* ---------- accounts UI ---------- */
function renderAccounts() {
  $("curAddr").textContent = current || "(no account yet)";
  const box = $("acctList"); box.innerHTML = "";
  for (const a of accounts) {
    const div = document.createElement("div");
    div.className = "acct" + (a.address === current ? " active" : "");
    const cnt = countsCache[a.address];
    div.innerHTML = "<span>" + esc(a.address) + "</span>" +
      (a.label ? "<span class='lbl'>" + esc(a.label) + "</span>" : "") +
      (cnt ? "<span class='cnt'>" + cnt.total + " mail" + (cnt.unread ? " · " + cnt.unread + " new" : "") + "</span>" : "") +
      "<span class='x' title='remove from this browser'>✕</span>";
    div.querySelector("span").onclick = async () => { current = a.address; await persist(); renderAccounts(); refreshInbox(true); };
    div.querySelector(".x").onclick = async ev => {
      ev.stopPropagation();
      accounts = accounts.filter(x => x.address !== a.address);
      delete tokenCache[a.address];
      if (current === a.address) current = accounts.length ? accounts[accounts.length - 1].address : null;
      await persist(); renderAccounts(); refreshInbox(true);
    };
    box.appendChild(div);
  }
}
function randPrefix() {
  const c = "abcdefghijklmnopqrstuvwxyz"; let s = "";
  for (let i = 0; i < 10; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
async function loadDomains() {
  try {
    const dr = await htmApi("GET", "/domains");
    domainsCache = htmAsList(dr.data).filter(d => d.isActive && !d.isPrivate).map(d => d.domain);
    const sel = $("domainSel");
    if (sel) {
      sel.innerHTML = "";
      for (const d of domainsCache) {
        const o = document.createElement("option");
        o.value = d; o.textContent = "@" + d;
        sel.appendChild(o);
      }
    }
  } catch (e) { /* create flow retries on its own */ }
  return domainsCache;
}
async function newAccount() {
  const btn = $("newBtn"); btn.disabled = true; setStatus("Creating…");
  try {
    if (!domainsCache.length) await loadDomains();
    if (!domainsCache.length) throw new Error("no domain available");
    const sel = $("domainSel");
    const domain = (sel && sel.value) || domainsCache[0];
    let prefix = ($("prefix").value.trim() || randPrefix()).toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 24);
    if (!prefix) prefix = randPrefix();
    const address = prefix + "@" + domain;
    const pw = Array.from(crypto.getRandomValues(new Uint8Array(18)))
                 .map(b => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62]).join("");
    const cr = await htmApi("POST", "/accounts", null, { address, password: pw });
    if (cr.status !== 200 && cr.status !== 201) throw new Error("create failed (" + cr.status + ") — name may be taken, try another");
    const a = { address, password: pw, label: $("label").value.trim() };
    tokenCache[address] = { t: await htmGetToken(a), at: Date.now() };
    accounts.push(a); current = address;
    await persist(); renderAccounts();
    $("prefix").value = ""; $("label").value = "";
    setStatus("Created ✓ Give this address to the site, then wait here for the OTP.", "ok");
    refreshInbox(true);
  } catch (e) { setStatus("Error: " + e.message, "err"); }
  btn.disabled = false;
}

/* ---------- inbox ---------- */
async function scanFull(tok, m) {
  const full = await htmApi("GET", "/messages/" + m.id, tok);
  if (full.status !== 200) return null;
  const { codes, link } = htmScanMessage(full.data);
  return { full: full.data, codes, link };
}
async function refreshInbox(reset) {
  const a = acct();
  const box = $("inbox");
  if (!a) { box.innerHTML = "<span class='dim'>Create an email first.</span>"; return; }
  try {
    const tok = await htmAuth(a, tokenCache);
    await persist();
    const r = await htmApi("GET", "/messages?page=1", tok);
    if (r.status !== 200) throw new Error("inbox failed (" + r.status + ")");
    const msgs = htmAsList(r.data);
    lastMsgs = msgs;
    countsCache[a.address] = { total: msgs.length, unread: msgs.filter(m => !m.seen).length, at: Date.now() };
    htmStore.set({ acctCounts: countsCache });
    renderAccounts();
    $("lastCheck").textContent = "checked " + new Date().toLocaleTimeString();
    renderInbox();
    let scannedNow = 0;
    for (const m of msgs) {
      if (scannedNow >= 5) break;
      if (scanned[m.id]) continue;
      if ((scanAttempts[m.id] || 0) >= 3) { scanned[m.id] = true; continue; }
      scanAttempts[m.id] = (scanAttempts[m.id] || 0) + 1;
      scannedNow++;
      const res = await scanFull(tok, m);
      if (!res) continue;
      scanned[m.id] = true;
      if (res.link) onLinkFound(res.link, (res.full.from || {}).address || "?", res.full.subject || "");
      if (res.codes.length) {
        onOtpFound(res.codes[0], (res.full.from || {}).address || "?", res.full.subject || "", m.id, a.address);
        break;
      }
    }
  } catch (e) {
    box.innerHTML = "<span class='err'>Could not load inbox: " + esc(e.message) + " — retrying automatically.</span>";
  }
}

function renderInbox() {
  const box = $("inbox");
  const q = (($("searchBox") && $("searchBox").value) || "").toLowerCase();
  const msgs = lastMsgs.filter(m => !q ||
    (m.subject || "").toLowerCase().includes(q) ||
    ((m.from || {}).address || "").toLowerCase().includes(q));
  if (!lastMsgs.length) { box.innerHTML = "<span class='dim'>Inbox empty — waiting for mail…</span>"; return; }
  if (!msgs.length) { box.innerHTML = "<span class='dim'>No mail matches the search.</span>"; return; }
  box.innerHTML = "";
  for (const m of msgs) {
    const div = document.createElement("div");
    div.className = "msg" + (m.seen ? "" : " unread");
    const when = (m.createdAt || "").replace("T", " ").slice(0, 19);
    div.innerHTML = "<span class='d'>" + esc(when) + "</span>" +
      "<div class='s'>" + esc(m.subject || "(no subject)") + "</div>" +
      "<div class='f'>from " + esc((m.from || {}).address || "?") + "</div>";
    div.onclick = () => openMessage(m.id);
    box.appendChild(div);
  }
}
async function huntAll() {
  if (!accounts.length) { setStatus("No accounts yet.", "err"); return; }
  const btn = $("huntBtn"); btn.disabled = true; setStatus("সব account খুঁজছি…");
  try {
    for (const a of accounts) {
      let tok;
      try { tok = await htmAuth(a, tokenCache); } catch (e) { continue; }
      const r = await htmApi("GET", "/messages?page=1", tok);
      if (r.status !== 200) continue;
      for (const m of htmAsList(r.data).slice(0, 3)) {
        const res = await scanFull(tok, m);
        if (!res) continue;
        if (res.codes.length) {
          current = a.address; await persist(); renderAccounts();
          if (res.link) onLinkFound(res.link, (res.full.from || {}).address || "?", res.full.subject || "");
          onOtpFound(res.codes[0], (res.full.from || {}).address || "?", res.full.subject || "", m.id, a.address);
          setStatus("OTP পাওয়া গেছে → " + a.address + (a.label ? " (" + a.label + ")" : ""), "ok");
          refreshInbox(true);
          btn.disabled = false;
          return;
        }
      }
    }
    setStatus("কোনো account-এর inbox-এ OTP পাইনি।", "err");
  } catch (e) { setStatus("Error: " + e.message, "err"); }
  btn.disabled = false;
}

/* ---------- reader ---------- */
async function openMessage(id) {
  const a = acct(); if (!a) return;
  currentMsgId = id;
  try {
    const tok = await htmAuth(a, tokenCache);
    const r = await htmApi("GET", "/messages/" + id, tok);
    if (r.status !== 200) throw new Error("open failed (" + r.status + ")");
    const m = r.data;
    $("reader").style.display = "block";
    $("rSubj").textContent = m.subject || "(no subject)";
    $("rMeta").textContent = "From: " + ((m.from || {}).address || "?") + "   •   " + (m.createdAt || "");
    $("rBody").textContent = m.text ||
      htmHtmlToText(Array.isArray(m.html) ? m.html.join("\n") : (m.html || "")) ||
      "(no readable body)";
    const { codes, link } = htmScanMessage(m);
    $("rOtps").innerHTML = codes.length
      ? "Possible code(s) — click to copy: " + codes.map(c => "<span class='chip'>" + esc(c) + "</span>").join("")
      : "";
    $("rOtps").querySelectorAll(".chip").forEach(ch => ch.onclick = () => copyText(ch.textContent, ch));
    const rl = $("rLinks");
    rl.innerHTML = "";
    if (link) {
      const aEl = document.createElement("a");
      aEl.className = "btn"; aEl.href = link; aEl.target = "_blank";
      aEl.rel = "noopener noreferrer"; aEl.textContent = "Open verification link";
      const bEl = document.createElement("button");
      bEl.className = "ghost"; bEl.textContent = "Copy link";
      bEl.onclick = () => copyText(link, bEl);
      rl.appendChild(aEl); rl.appendChild(document.createTextNode(" "));
      rl.appendChild(bEl);
      onLinkFound(link, (m.from || {}).address || "?", m.subject || "");
    }
    if (codes.length) onOtpFound(codes[0], (m.from || {}).address || "?", m.subject || "", id, a.address);
    $("reader").scrollIntoView({ behavior: "smooth" });
  } catch (e) { setStatus("Error: " + e.message, "err"); }
}
async function deleteMessage() {
  const a = acct(); if (!a || !currentMsgId) return;
  try {
    const tok = await htmAuth(a, tokenCache);
    await htmApi("DELETE", "/messages/" + currentMsgId, tok);
    $("reader").style.display = "none"; currentMsgId = null;
    refreshInbox(true);
  } catch (e) { setStatus("Error: " + e.message, "err"); }
}

/* ---------- export / import ---------- */
function exportAccounts() {
  if (!confirm("Warning: the backup file contains your mailbox passwords in plain text. Keep it private — anyone with the file can read those inboxes. Continue?")) return;
  const blob = new Blob([JSON.stringify({ accounts, current }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "hexa-tempmail-accounts.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importAccounts(file) {
  const rd = new FileReader();
  rd.onload = async () => {
    try {
      const d = JSON.parse(rd.result);
      let added = 0;
      for (const a of (d.accounts || [])) {
        if (a && a.address && a.password && !accounts.some(x => x.address === a.address)) {
          accounts.push({ address: a.address, password: a.password, label: a.label || "" }); added++;
        }
      }
      if (!current && accounts.length) current = accounts[accounts.length - 1].address;
      await persist(); renderAccounts(); refreshInbox(true);
      setStatus("Import done — " + added + " account(s) added.", "ok");
    } catch (e) { setStatus("Import failed: not a valid backup file.", "err"); }
  };
  rd.readAsText(file);
}

/* ---------- form fill (popup only) ---------- */
async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}
async function fillEmail() {
  if (!current) { setStatus("আগে একটা email বানাও।", "err"); return; }
  try {
    const tab = await activeTab();
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: htmFillEmailInPage, args: [current]
    });
    const r = res && res.result;
    setStatus(r && r.ok ? "Email বসানো হয়েছে ✓ (" + (r.field || "field") + ")" : "এই page-এ email field পাইনি।",
              r && r.ok ? "ok" : "err");
  } catch (e) { setStatus("এই page-এ fill করা যায় না (browser page হলে এমন হয়)।", "err"); }
}
async function fillOtp() {
  if (!latestOtp) { setStatus("এখনো কোনো OTP আসেনি।", "err"); return; }
  try {
    const tab = await activeTab();
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: htmFillOtpInPage, args: [latestOtp.code]
    });
    const r = res && res.result;
    setStatus(r && r.ok ? "OTP বসানো হয়েছে ✓" : "এই page-এ OTP field পাইনি।", r && r.ok ? "ok" : "err");
  } catch (e) { setStatus("এই page-এ fill করা যায় না (browser page হলে এমন হয়)।", "err"); }
}

/* ---------- background alert ---------- */
async function showStoredAlert() {
  const st = await htmStore.get(["inboxAlert"]);
  const al = st.inboxAlert;
  if (!al || !al.ts || al.ts <= dismissedAlertTs) return;
  if (al.link) onLinkFound(al.link, al.from, al.subject);
  if (al.code) onOtpFound(al.code, al.from, al.subject, "bg" + al.ts, al.address, false);
  if (al.address && al.address !== current && accounts.some(a => a.address === al.address)) {
    setStatus("Background watcher: নতুন OTP এসেছে → " + al.address, "ok");
  }
}

/* ---------- timer / settings ---------- */
function restartTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { if (settings.autoRef) refreshInbox(false); }, 5000);
}
async function onSettingChange() {
  settings.autoCopy = $("autoCopy").checked;
  settings.soundOn = $("soundOn").checked;
  settings.autoRef = $("autoRef").checked;
  await persist();
}

/* ---------- init ---------- */
async function init() {
  const st = await htmStore.get(["accounts", "current", "tokens", "settings", "dismissedAlertTs"]);
  accounts = st.accounts || [];
  current = st.current || null;
  tokenCache = st.tokens || {};
  if (st.settings) settings = Object.assign(settings, st.settings);
  dismissedAlertTs = st.dismissedAlertTs || 0;
  $("autoCopy").checked = !!settings.autoCopy;
  $("soundOn").checked = !!settings.soundOn;
  $("autoRef").checked = !!settings.autoRef;
  const extra = await htmStore.get(["otpHistory", "acctCounts"]);
  otpHistory = extra.otpHistory || [];
  countsCache = extra.acctCounts || {};
  if (typeof chrome !== "undefined" && chrome.action) chrome.action.setBadgeText({ text: "" });
  renderAccounts();
  renderHistory();
  loadDomains();
  await showStoredAlert();
  refreshInbox(true);
  restartTimer();
}
$("newBtn").onclick = newAccount;
$("refBtn").onclick = () => refreshInbox(true);
$("copyAddr").onclick = e => { if (current) copyText(current, e.target); };
$("otpCopy").onclick = e => { if (latestOtp) copyText(latestOtp.code, e.target); };
$("linkCopy").onclick = e => { if (latestLink) copyText(latestLink.url, e.target); };
$("delBtn").onclick = deleteMessage;
$("huntBtn").onclick = huntAll;
$("exportBtn").onclick = exportAccounts;
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = e => { if (e.target.files[0]) importAccounts(e.target.files[0]); e.target.value = ""; };
$("autoCopy").onchange = onSettingChange;
$("soundOn").onchange = onSettingChange;
$("autoRef").onchange = onSettingChange;
const fe = $("fillEmailBtn"); if (fe) fe.onclick = fillEmail;
const fo = $("otpFill"); if (fo) fo.onclick = fillOtp;
const op = $("openPageBtn"); if (op) op.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("page.html") });
const sb = $("searchBox"); if (sb) sb.oninput = renderInbox;
const hc = $("histClear"); if (hc) hc.onclick = async () => { otpHistory = []; await htmStore.set({ otpHistory }); renderHistory(); };
$("otpDismiss").onclick = async () => { $("otpBox").style.display = "none"; dismissedAlertTs = Date.now(); await persist(); };
$("linkDismiss").onclick = async () => { $("linkBox").style.display = "none"; dismissedAlertTs = Date.now(); await persist(); };
init();
