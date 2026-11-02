# Changelog

## [2.0.0] — 2026-11-02

### Added
- **Domain picker** — choose the domain for each new address from the live list of active mail.tm domains.
- **Recent OTPs history** — last 10 codes across all accounts (sender, time, subject), click to copy; the background watcher records codes even while the popup is closed.
- **Per-account counters** — each address shows its total mail and unread counts.
- **Right-click fill** — context-menu entries to fill the email field or the latest OTP on any page.
- **Inbox search** — filter by subject or sender.
- **HTML-only mail reading** — HTML parts are converted to readable text in the message reader.

### Fixed
- Token validation is cached (at most once per 10 minutes per account) instead of an API call on every refresh.
- Failed message scans no longer mark the message scanned — an OTP can't be silently skipped; bounded retries instead.
- Empty/symbol-only custom prefixes fall back to a random name; prefixes are capped at 24 characters.
- Background watcher: per-account error isolation — one bad account can't block the rest.
- Reader verification link is now built with safe DOM APIs instead of string HTML.
- Export shows a plain-text-password warning before downloading the backup file.

## [1.0.0] — 2026-11-01

- First release: one-click temporary addresses on mail.tm, keyword-scored OTP
  extraction, verification-link extraction, auto-copy + sound, one-click form
  fill (including split OTP boxes), hunt across all accounts, background
  watcher with badge + notifications, full-page mode, export/import.
