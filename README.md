
# WhatsApp Vlog Wheel Bot — Replit-ready (Full-featured)

This repository contains a full-featured WhatsApp bot built with **Baileys** (WhatsApp Web protocol).  
It picks a daily member (05:00→next day 04:59), asks them to record video or voice, accepts multiple uploads, supports approval/rejection voting, tracks streaks, and announces admin-for-a-week when a streak is broken.

---

## Files
- `index.js` — main bot code
- `package.json` — dependencies & start script
- `data.json` — persistent state (auto-created)
- `auth_info.json` — WhatsApp auth (created after QR scan)
- `README.md` — this file

---

## Quick steps to run on Replit (beginner-friendly)

1. Go to https://replit.com and create a new **Node.js** repl.
2. Import this ZIP (use Replit's "Import from ZIP") or create files manually and paste contents.
3. In Replit, open the "Secrets" (lock icon) and optionally set:
   - `GROUP_JID` = your_group_jid (e.g. 201234567890-123456@g.us) — optional
   - `PORT` = 3000 (optional)
4. Click **Run**.
5. Open the **Console** tab — you should see an ASCII QR code.  
   - On your phone: WhatsApp → Menu → Linked devices → Link a device → Scan QR.
   - If scanning ASCII fails, open `https://<your-repl>.repl.co/qr` to view the QR image.
6. Add the logged-in WhatsApp account (the one you scanned with) to your target group.
7. Use commands in the group:
   - `!status` — bot status
   - `!pick` — manual pick
   - `!sync` — sync group participants into members
   - `!leaderboard` — view streak leaderboard
   - `!addmember <jid> <name>` — adds a member to DB

---

## Notes & Tips
- Replit free instances can sleep. For 24/7 uptime consider Replit’s "Always On" (Hacker) or use a VPS.
- Keep `auth_info.json` safe — it contains your session. Do not share it.
- The bot cannot auto-promote admins reliably; it will announce who should be promoted.
- For reliability you can back up `data.json` and `auth_info.json` periodically.

---

If you want, I can:
- Upload this repo to a GitHub repo and give you an "Import from GitHub" link for Replit.
- Generate the ZIP for you to download and import to Replit now.
