"use strict";
/* Hexa TempMail — background watcher.
   Polls every account's inbox (alarm, ~1 min), and when a NEW mail carries
   an OTP or a verification link: badge + notification + stored alert that
   the popup/page shows instantly on open. */
importScripts("core.js", "fill.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("htm-poll", { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("htm-poll", { periodInMinutes: 1 });
  htmPoll();
});
chrome.alarms.onAlarm.addListener(a => { if (a.name === "htm-poll") htmPoll(); });

/* ---------- right-click fill (context menus) ---------- */
function htmMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: "htm-fill-email", title: "Hexa TempMail: এই field-এ email বসাও", contexts: ["editable"] });
      chrome.contextMenus.create({ id: "htm-fill-otp", title: "Hexa TempMail: সর্বশেষ OTP বসাও", contexts: ["editable"] });
    });
  } catch (e) {}
}
chrome.runtime.onInstalled.addListener(htmMenus);
chrome.runtime.onStartup.addListener(htmMenus);
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const fail = msg => chrome.notifications.create("htm-menu-" + Date.now(), {
    type: "basic", iconUrl: "icons/icon128.png", title: "Hexa TempMail", message: msg });
  try {
    if (info.menuItemId === "htm-fill-email") {
      const st = await htmStore.get(["current"]);
      if (!st.current) return fail("আগে extension খুলে একটা email বানাও।");
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: htmFillEmailInPage, args: [st.current] });
      const r = res && res.result;
      if (!r || !r.ok) fail("এই field-এ বসানো গেল না।");
    } else if (info.menuItemId === "htm-fill-otp") {
      const st = await htmStore.get(["otpHistory", "inboxAlert"]);
      const code = (st.otpHistory && st.otpHistory[0] && st.otpHistory[0].code) ||
                   (st.inboxAlert && st.inboxAlert.code);
      if (!code) return fail("এখনো কোনো OTP আসেনি।");
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: htmFillOtpInPage, args: [code] });
      const r = res && res.result;
      if (!r || !r.ok) fail("এই field-এ OTP বসানো গেল না।");
    }
  } catch (e) { fail("এই page-এ fill করা যায় না।"); }
});

let polling = false;
async function htmPoll() {
  if (polling) return;
  polling = true;
  try {
    const st = await htmStore.get(["accounts", "tokens", "seenIds"]);
    const accounts = st.accounts || [];
    const tokens = st.tokens || {};
    const seenIds = st.seenIds || {};
    let changed = false;

    const countsSt = await htmStore.get(["acctCounts", "otpHistory"]);
    const acctCounts = countsSt.acctCounts || {};
    let otpHistory = countsSt.otpHistory || [];

    for (const acct of accounts) {
     try {
      let tok;
      try { tok = await htmAuth(acct, tokens); changed = true; }
      catch (e) { continue; }
      const r = await htmApi("GET", "/messages?page=1", tok);
      if (r.status !== 200) continue;
      const msgs = htmAsList(r.data);
      acctCounts[acct.address] = {
        total: msgs.length,
        unread: msgs.filter(m => !m.seen).length,
        at: Date.now()
      };
      const seen = new Set(seenIds[acct.address] || []);
      const firstRun = !seenIds[acct.address];
      const fresh = msgs.filter(m => !seen.has(m.id));
      for (const m of msgs) seen.add(m.id);
      seenIds[acct.address] = Array.from(seen).slice(-120);
      changed = true;
      if (firstRun) continue;  // don't alert for mail that predates the watch

      for (const m of fresh.slice(0, 3)) {
        const fr = await htmApi("GET", "/messages/" + m.id, tok);
        if (fr.status !== 200) continue;
        const { codes, link } = htmScanMessage(fr.data);
        if (!codes.length && !link) continue;
        const alert = {
          address: acct.address,
          label: acct.label || "",
          code: codes.length ? codes[0] : null,
          link: link || null,
          from: (fr.data.from || {}).address || "?",
          subject: fr.data.subject || "",
          ts: Date.now()
        };
        await htmStore.set({ inboxAlert: alert });
        if (alert.code) {
          const dup = otpHistory.some(h => h.code === alert.code &&
            h.address === alert.address && (Date.now() - h.ts) < 15 * 60 * 1000);
          if (!dup) {
            otpHistory.unshift({ code: alert.code, address: alert.address,
              label: alert.label, from: alert.from, subject: alert.subject, ts: alert.ts });
            otpHistory = otpHistory.slice(0, 10);
            await htmStore.set({ otpHistory });
          }
        }
        chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
        chrome.action.setBadgeText({ text: codes.length ? "OTP" : "1" });
        chrome.notifications.create("htm-" + Date.now(), {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: codes.length ? ("OTP: " + codes[0]) : "Verification link arrived",
          message: (acct.label ? acct.label + " — " : "") + acct.address +
                   "\nfrom " + alert.from
        });
        break;  // one alert per account per poll is enough
      }
     } catch (e) { /* one bad account must not block the others */ }
    }
    await htmStore.set({ acctCounts });
    if (changed) await htmStore.set({ tokens, seenIds });
  } catch (e) {
    /* network hiccup — next alarm retries */
  }
  polling = false;
}
