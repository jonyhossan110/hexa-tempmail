"use strict";
/* Injected into the active tab by chrome.scripting.executeScript.
   Each function is fully self-contained (executeScript serialises it). */

function htmFillEmailInPage(address) {
  function visible(el) {
    const r = el.getClientRects();
    return r.length && el.type !== "hidden" && !el.disabled && !el.readOnly;
  }
  function setVal(el, val) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const inputs = Array.from(document.querySelectorAll("input")).filter(visible);
  const score = el => {
    const hay = ((el.type || "") + " " + (el.name || "") + " " + (el.id || "") + " " +
                 (el.autocomplete || "") + " " + (el.placeholder || "")).toLowerCase();
    let s = 0;
    if (el.type === "email") s += 10;
    if (/e-?mail/.test(hay)) s += 8;
    if (/user/.test(hay)) s += 2;
    if (/otp|code|pin|pass/.test(hay)) s -= 10;
    return s;
  };
  const cands = inputs.map(el => ({ el, s: score(el) })).filter(x => x.s > 0)
                      .sort((a, b) => b.s - a.s);
  if (!cands.length) return { ok: false, reason: "no email field found" };
  const el = cands[0].el;
  el.focus();
  setVal(el, address);
  return { ok: true, field: el.name || el.id || el.type };
}

function htmFillOtpInPage(code) {
  function visible(el) {
    const r = el.getClientRects();
    return r.length && el.type !== "hidden" && !el.disabled && !el.readOnly;
  }
  function setVal(el, val) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: val.slice(-1) || "" }));
  }
  const digits = String(code).replace(/\D/g, "");
  const inputs = Array.from(document.querySelectorAll("input")).filter(visible);

  // 1) a dedicated one-time-code field
  let el = inputs.find(i => (i.autocomplete || "") === "one-time-code");
  // 2) a field whose name/id/placeholder mentions otp/code/pin
  if (!el) el = inputs.find(i => /otp|one[-_ ]?time|passcode|verif/.test(
    ((i.name || "") + " " + (i.id || "") + " " + (i.placeholder || "")).toLowerCase()));
  if (!el) el = inputs.find(i => /\bcode\b|\bpin\b/.test(
    ((i.name || "") + " " + (i.id || "") + " " + (i.placeholder || "")).toLowerCase())
    && (i.maxLength === -1 || i.maxLength >= 4));
  if (el) { el.focus(); setVal(el, String(code)); return { ok: true, mode: "single" }; }

  // 3) split boxes: a run of >=4 single-character inputs
  const singles = inputs.filter(i => i.maxLength === 1 ||
    (i.size === 1 && (i.inputMode === "numeric" || i.type === "tel" || i.type === "text")));
  if (digits.length >= 4 && singles.length >= digits.length) {
    for (let k = 0; k < digits.length; k++) { singles[k].focus(); setVal(singles[k], digits[k]); }
    return { ok: true, mode: "split", boxes: digits.length };
  }
  return { ok: false, reason: "no OTP field found" };
}
