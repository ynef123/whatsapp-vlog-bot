
/*
Full-featured WhatsApp Vlog Wheel Bot (index.js)
Designed for Replit / Node.js environments.

Features:
- Baileys WhatsApp Web connection with QR (ASCII + optional HTTP QR endpoint)
- Daily pick with custom day window (05:00 -> next day 04:59)
- Multiple uploads allowed per picked user per day
- Picked user chooses between 'video' or 'voice' (bot prompts via DM)
- Voting in group via replies or text 'approve'/'reject' — votes tally
- Streak tracking, leaderboard, admin-for-a-week assignment (bot announces who should be admin)
- Persistent JSON storage (data.json) for state (picks, submissions, streaks, members, admin)
- Auto-sync group participants (when bot sees group metadata or via command)
- Simple Express status page and QR image route (helps scanning QR in Replit)
- CLI helper to add members

NOTE: This bot uses Baileys (WhatsApp Web protocol). Scan QR once. Keep the auth_info.json safe.
*/

// --- Imports
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useSingleFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const express = require('express');

// --- Paths
const DATA_FILE = path.resolve(__dirname, 'data.json');
const AUTH_FILE = path.resolve(__dirname, 'auth_info.json');

// --- Load / Save DB
function loadDB() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {
      config: {
        groupJid: process.env.GROUP_JID || '',
        dayStartHour: 5, // 5 -> day runs 05:00 to next day 04:59
      },
      members: {}, // jid -> {jid,name}
      picks: {}, // dateStr -> {member, submissionIds:[], chosenType: 'video'|'voice'|null}
      submissions: {}, // id -> {id, from, type, ts, votes:{jid:true/false}, finalized, approved}
      streaks: {}, // jid -> {current, lastDate}
      admin: null
    };
  }
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
let DB = loadDB();

// --- Auth state
const { state, saveState } = useSingleFileAuthState(AUTH_FILE);

// Utility
function todayKey(date = new Date()) {
  // day starts at DB.config.dayStartHour
  const h = DB.config.dayStartHour || 5;
  const d = new Date(date);
  // If hour < start, consider it previous day for "today" purposes
  if (d.getHours() < h) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0,10);
}
function getDayWindow(date = new Date()) {
  const start = new Date(date);
  start.setHours(DB.config.dayStartHour || 5, 0, 0, 0);
  const end = new Date(start.getTime() + 24*60*60*1000 - 1);
  return { start, end };
}

function memberShort(jid) {
  return DB.members[jid]?.name || jid.split('@')[0];
}

// --- Start bot
async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ auth: state, logger: P({ level: 'silent' }), version });

  // expose current QR (base64) for HTTP endpoint
  let lastQRDataUrl = null;

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      // generate data url for web route
      qrcode.toDataURL(qr, (err, url) => {
        if (!err) lastQRDataUrl = url;
      });
      // print ascii to console too
      try { qrcodeTerminal.generate(qr, { small: true }); } catch (e) {}
      console.log('[BOT] Scan QR from console or /qr endpoint.');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('[BOT] Connection closed', code);
      if (code === DisconnectReason.loggedOut) {
        console.log('[BOT] Logged out. Deleting auth file.');
        try { fs.unlinkSync(AUTH_FILE); } catch(e) {}
      }
      // reconnect
      setTimeout(() => startBot(), 2000);
    } else if (connection === 'open') {
      console.log('[BOT] Connected.');
      // sync group participants if groupJid set
      if (DB.config.groupJid) syncGroupParticipants(sock, DB.config.groupJid).catch(e=>console.error(e));
    }
  });

  sock.ev.on('creds.update', saveState);

  // message handling
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msgs = m.messages;
      if (!msgs) return;
      for (const msg of msgs) {
        if (!msg.message) continue;
        const jid = msg.key.remoteJid;
        // ignore status messages
        if (jid === 'status@broadcast') continue;

        // If groupJid set and it's different, ignore
        if (DB.config.groupJid && jid !== DB.config.groupJid) continue;

        const sender = msg.key.participant || msg.key.remoteJid;
        // handle different message types
        if (msg.message.audioMessage || msg.message.videoMessage || msg.message.documentMessage || msg.message.videoMessage || msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
          // treat as possible submission or vote (if reply to announcement)
          await handleMediaOrReply(msg, sock);
          continue;
        }
        // text
        let text = '';
        if (msg.message.conversation) text = msg.message.conversation;
        if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) text = msg.message.extendedTextMessage.text;
        if (!text) continue;
        text = text.trim();

        // basic commands only from group (or any)
        const lower = text.toLowerCase();
        if (lower === '!status') {
          await sendStatus(sock, jid);
        } else if (lower === '!pick') {
          await manualPick(sock, jid);
        } else if (lower.startsWith('!addmember')) {
          // !addmember 201234567890@s.whatsapp.net Name
          const parts = text.split(' ');
          if (parts[1]) {
            const mJid = parts[1];
            const name = parts.slice(2).join(' ') || mJid.split('@')[0];
            DB.members[mJid] = { jid: mJid, name };
            saveDB(DB);
            await sock.sendMessage(jid, { text: `[BOT] Added member ${name}` });
          }
        } else if (['approve','yes','👍'].includes(lower)) {
          await handleVoteText(msg, true, sock);
        } else if (['reject','no','👎'].includes(lower)) {
          await handleVoteText(msg, false, sock);
        } else if (lower === '!sync') {
          if (DB.config.groupJid) {
            await syncGroupParticipants(sock, DB.config.groupJid);
            await sock.sendMessage(jid, { text: '[BOT] Synced group participants into members list.' });
          } else {
            await sock.sendMessage(jid, { text: '[BOT] GROUP_JID not configured.' });
          }
        } else if (lower === '!leaderboard') {
          await sendLeaderboard(sock, jid);
        }
      }
    } catch (e) { console.error('messages.upsert err', e); }
  });

  // schedule: run daily at DB.config.dayStartHour to finalize previous day and pick new member
  const hour = DB.config.dayStartHour || 5;
  // schedule at hour:00 server time
  schedule.scheduleJob({ hour, minute: 0 }, async () => {
    try {
      await finalizePreviousDayAndPick(sock);
    } catch(e){ console.error(e); }
  });

  // express for QR image and status
  const app = express();
  app.get('/status', (req,res)=> res.json({ ok:true, members: Object.keys(DB.members).length }));
  app.get('/qr', (req,res)=> {
    // serve last QR data url if available
    if (!lastQRDataUrl) return res.send('<h3>No QR available — start the bot and check console</h3>');
    res.send(`<img src="${lastQRDataUrl}" alt="qr"/><p>Scan from WhatsApp Linked Devices -> Link a device</p>`);
  });
  app.listen(process.env.PORT || 3000, ()=> console.log('[HTTP] Listening on port', process.env.PORT || 3000));
}

// --- Helpers

async function handleMediaOrReply(msg, sock) {
  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  const dateKey = todayKey();
  const pick = DB.picks[dateKey];

  // If this message is a reply to an announcement message, and it's 'approve'/'reject', treat as vote
  const ctx = msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
  if (ctx && ctx.quotedMessage) {
    // if quoted message contains BOT label hint, check submission mapping
    const quotedId = ctx.stanzaId || ctx.quotedMessageContextInfo?.stanzaId || ctx.quotedMessage?.key?.id;
    // Try to map to submission by stored announceMessageKey (we store id.key.id)
    for (const sid of Object.keys(DB.submissions)) {
      const s = DB.submissions[sid];
      if (s.announceMessageId && quotedId && s.announceMessageId === quotedId) {
        // if sender message text says approve/reject... but here it's media or reply - skip
      }
    }
  }

  // if message contains media (audio/video/doc), treat as a submission candidate
  if (msg.message.audioMessage || msg.message.videoMessage || msg.message.documentMessage || msg.message.voiceMessage) {
    // determine type preference from pick
    const type = msg.message.videoMessage ? 'video' : 'voice';
    // allow multiple uploads: mark submission for picked user only
    if (pick && pick.member === sender) {
      const sid = 's' + Date.now();
      DB.submissions[sid] = { id: sid, from: sender, type, ts: Date.now(), votes: {}, finalized: false };
      // attach to pick
      pick.submissionIds = pick.submissionIds || [];
      pick.submissionIds.push(sid);
      DB.picks[dateKey] = pick;
      saveDB(DB);
      // announce
      const reply = await sock.sendMessage(jid, { text: `[BOT] Submission received from @${memberShort(sender)}. Please vote by replying 'approve' or 'reject'.`, mentions: [sender] });
      // store announce message id for reply mapping
      DB.submissions[sid].announceMessageId = reply.key.id;
      saveDB(DB);
      return;
    } else {
      // not today's pick; store as general submission optionally
      const sid = 's' + Date.now();
      DB.submissions[sid] = { id: sid, from: sender, type, ts: Date.now(), votes: {}, finalized: false, note: 'not-picked' };
      saveDB(DB);
      await sock.sendMessage(jid, { text: `[BOT] Received media from @${memberShort(sender)} (not today's pick).`, mentions: [sender] });
      return;
    }
  }
}

async function handleVoteText(msg, approve, sock) {
  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  // If reply to a bot announce, map to submission
  const ctx = msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
  let mapped = null;
  if (ctx && ctx.quotedMessage) {
    const quotedId = ctx.stanzaId || ctx.quotedMessageContextInfo?.stanzaId || (ctx.quotedMessage?.key && ctx.quotedMessage.key.id);
    for (const sid of Object.keys(DB.submissions)) {
      const s = DB.submissions[sid];
      if (s.announceMessageId && quotedId && s.announceMessageId === quotedId) { mapped = s; break; }
    }
  }
  // fallback: map to latest submission of today's pick
  if (!mapped) {
    const dateKey = todayKey();
    const pick = DB.picks[dateKey];
    if (pick && pick.submissionIds && pick.submissionIds.length) {
      const sid = pick.submissionIds[pick.submissionIds.length - 1];
      mapped = DB.submissions[sid];
    }
  }
  if (!mapped) {
    await sock.sendMessage(jid, { text: '[BOT] No submission found to vote on.' });
    return;
  }
  mapped.votes = mapped.votes || {};
  mapped.votes[sender] = approve;
  saveDB(DB);
  await sock.sendMessage(jid, { text: `[BOT] Recorded vote from @${memberShort(sender)}: ${approve ? 'approve' : 'reject'}`, mentions: [sender] });
  evaluateSubmissionOutcome(mapped.id, sock);
}

function evaluateSubmissionOutcome(subId, sock) {
  const sub = DB.submissions[subId];
  if (!sub) return;
  const votes = Object.values(sub.votes || {});
  const approves = votes.filter(v=>v===true).length;
  const rejects = votes.filter(v=>v===false).length;
  const total = approves + rejects;
  const memberCount = Object.keys(DB.members).length || 1;
  // rules:
  // - if approves > rejects and approves>=1 => approved
  // - if rejects > approves and total >= memberCount-1 => rejected
  if (approves > rejects && approves >= 1) finalizeSubmission(subId, true, sock);
  else if (rejects > approves && total >= Math.max(1, memberCount-1)) finalizeSubmission(subId, false, sock);
}

async function finalizeSubmission(subId, approved, sock) {
  const sub = DB.submissions[subId];
  if (!sub || sub.finalized) return;
  sub.finalized = true; sub.approved = approved; saveDB(DB);
  const from = sub.from;
  const dateKey = todayKey();
  if (approved) {
    const prev = DB.streaks[from] || { current: 0, lastDate: null };
    const yesterdayKey = (()=>{ const d = new Date(); d.setDate(d.getDate()-1); return todayKey(d); })();
    const newCur = (prev.lastDate === yesterdayKey) ? prev.current + 1 : 1;
    DB.streaks[from] = { current: newCur, lastDate: dateKey };
    saveDB(DB);
    await sock.sendMessage(DB.config.groupJid || from, { text: `[BOT] Approved: @${memberShort(from)}. Streak: ${newCur}`, mentions: [from] });
  } else {
    // broken streak
    DB.streaks[from] = { current: 0, lastDate: DB.streaks[from] ? DB.streaks[from].lastDate : null };
    // last rejecter becomes admin label
    const lastRejecter = Object.keys(sub.votes || {}).reverse().find(k => sub.votes[k] === false) || null;
    if (lastRejecter) {
      DB.admin = { member: lastRejecter, expiresAt: Date.now() + 7*24*60*60*1000 };
      saveDB(DB);
      await sock.sendMessage(DB.config.groupJid || from, { text: `[BOT] Rejected: @${memberShort(from)}. @${memberShort(lastRejecter)} is declared admin for a week (please have owner promote).`, mentions:[from, lastRejecter] });
    } else {
      await sock.sendMessage(DB.config.groupJid || from, { text: `[BOT] Rejected: @${memberShort(from)}.` });
    }
  }
}

async function finalizePreviousDayAndPick(sock) {
  // finalize any pending submissions (for previous day) — simplistic: process latest submission only
  const prevDate = (()=>{ const d = new Date(); d.setDate(d.getDate()-1); return todayKey(d); })();
  // check previous picks and finalize any non-finalized submissions as rejected if no votes
  const prevPick = DB.picks[prevDate];
  if (prevPick && prevPick.submissionIds && prevPick.submissionIds.length) {
    for (const sid of prevPick.submissionIds) {
      const s = DB.submissions[sid];
      if (s && !s.finalized) {
        // if no votes, reject; else evaluate outcome
        const votes = Object.values(s.votes||{});
        if (votes.length === 0) {
          await finalizeSubmission(sid, false, sock);
        } else {
          evaluateSubmissionOutcome(sid, sock);
        }
      }
    }
  }
  // pick new member for today
  const members = Object.keys(DB.members);
  if (!members.length) { console.log('[BOT] No members to pick.'); return; }
  const idx = Math.floor(Math.random()*members.length);
  const picked = members[idx];
  const dateKey = todayKey(new Date());
  DB.picks[dateKey] = { member: picked, submissionIds: [], chosenType: null };
  saveDB(DB);
  // DM picked asking for choice
  try {
    await sock.sendMessage(picked, { text: `[BOT] You were picked for today. Reply with 'video' or 'voice' to choose how you'll record.` });
  } catch(e) {
    // can't DM? announce in group
    await sock.sendMessage(DB.config.groupJid, { text: `[BOT] Today's pick: @${memberShort(picked)} — please record video or voice as they choose.`, mentions: [picked] });
  }
  await sock.sendMessage(DB.config.groupJid, { text: `[BOT] Today's pick: @${memberShort(picked)} — they will record during the 05:00-04:59 window.` , mentions:[picked]});
}

async function manualPick(sock, jid) {
  const members = Object.keys(DB.members);
  if (!members.length) return;
  const idx = Math.floor(Math.random()*members.length);
  const picked = members[idx];
  const dateKey = todayKey(new Date());
  DB.picks[dateKey] = { member: picked, submissionIds: [], chosenType: null };
  saveDB(DB);
  await sock.sendMessage(jid, { text: `[BOT] Manual pick: @${memberShort(picked)}`, mentions:[picked] });
}

async function syncGroupParticipants(sock, groupJid) {
  // fetch group metadata
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const participants = metadata.participants || [];
    participants.forEach(p => {
      DB.members[p.id] = { jid: p.id, name: p.id.split('@')[0] };
    });
    saveDB(DB);
    console.log('[BOT] Synced participants into DB.members');
  } catch (e) { console.error('[BOT] syncGroupParticipants error', e); }
}

async function sendStatus(sock, jid) {
  const lines = [];
  lines.push('[BOT] Status:');
  lines.push('Members: ' + Object.keys(DB.members).map(j=>memberShort(j)).join(', '));
  const today = todayKey();
  const pick = DB.picks[today];
  lines.push('Today: ' + (pick ? memberShort(pick.member) : 'none'));
  if (DB.admin && DB.admin.expiresAt > Date.now()) lines.push('Admin label: ' + memberShort(DB.admin.member) + ' until ' + new Date(DB.admin.expiresAt).toLocaleString());
  await sock.sendMessage(jid, { text: lines.join('\\n') });
}

async function sendLeaderboard(sock, jid) {
  const items = Object.entries(DB.streaks).map(([jid,s])=>({ jid, current: s.current||0 }));
  items.sort((a,b)=>b.current - a.current);
  const lines = items.slice(0,10).map(i=>`${memberShort(i.jid)}: ${i.current}`);
  await sock.sendMessage(jid, { text: '[BOT] Leaderboard:\\n' + (lines.length ? lines.join('\\n') : 'No streaks yet') });
}

// CLI helper to add member
if (process.argv[2] === 'addMember' && process.argv[3]) {
  const j = process.argv[3];
  const n = process.argv[4] || j.split('@')[0];
  DB.members[j] = { jid: j, name: n };
  saveDB(DB);
  console.log('Added member', j, n);
  process.exit(0);
}

// Start
startBot().catch(e=>console.error(e));
