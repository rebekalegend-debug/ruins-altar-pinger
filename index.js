import { Client, GatewayIntentBits, Partials } from "discord.js";
import { DateTime } from "luxon";
import express from "express";
import fs from "fs";
import path from "path";

/* ================= CONFIG ================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;
const REMINDER_SUFFIX = process.env.REMINDER_SUFFIX || "Send march!";
const COMMAND_ROLE_ID = "1470030804653445212";

const PREFIX = "-";
const TZ = "UTC";

/* ========================================== */

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!ANNOUNCE_CHANNEL_ID) throw new Error("Missing ANNOUNCE_CHANNEL_ID");

/* ================= PATHS ================= */

const BASE = process.cwd();
const SCHEDULE_DIR = path.join(BASE, "schedules");
const RUINS_FILE = path.join(SCHEDULE_DIR, "ruins.txt");
const ALTAR_FILE = path.join(SCHEDULE_DIR, "altar.txt");
const STATE_FILE = path.join(BASE, "state.json");

/* ================= STATE ================= */

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
} catch {
  state = { notified: {} };
}

let events = [];

/* ================= UTILS ================= */

const hasRole = (member) =>
  member?.roles?.cache?.has(COMMAND_ROLE_ID);

const fmt = (dt) =>
  dt.toUTC().toFormat("ccc dd.LL HH:mm 'UTC'");

function normalize(line) {
  return line.trim().replace(/\s+/g, " ").replace(/^[A-Za-z]{3},\s*/g, "");
}

function parseUTC(line) {
  const s = normalize(line);
  if (!s || s.startsWith("#")) return null;

  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const [_, d, mo, h, mi] = m.map(Number);
  const now = DateTime.now().setZone(TZ);

  let dt = DateTime.fromObject(
    { year: now.year, month: mo, day: d, hour: h, minute: mi },
    { zone: TZ }
  );

  if (dt < now.minus({ minutes: 5 })) dt = dt.plus({ years: 1 });
  return dt;
}

function readSchedule(file, type) {
  if (!fs.existsSync(file)) return [];
  const seen = new Set();
  const out = [];

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const dt = parseUTC(line);
    if (!dt) continue;

    const key = `${type}:${dt.toISO()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ type, startsAt: dt, key });
  }

  return out.sort((a, b) => a.startsAt - b.startsAt);
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function loadAll() {
  if (!fs.existsSync(SCHEDULE_DIR)) {
    fs.mkdirSync(SCHEDULE_DIR, { recursive: true });
  }

  events = [
    ...readSchedule(RUINS_FILE, "ruins"),
    ...readSchedule(ALTAR_FILE, "altar")
  ].sort((a, b) => a.startsAt - b.startsAt);

  const cutoff = DateTime.now().setZone(TZ).minus({ days: 14 });
  for (const k of Object.keys(state.notified)) {
    const iso = k.split(":")[1];
    const t = DateTime.fromISO(iso, { zone: TZ });
    if (t.isValid && t < cutoff) delete state.notified[k];
  }

  saveState();
  console.log(`[INFO] Loaded ${events.length} events`);
}

/* ================= DISCORD ================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

/* ================= REMINDERS ================= */

async function sendReminder(ev) {
  const ch = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
  if (!ch?.isTextBased()) return;

  const label = ev.type === "ruins" ? "Ruins" : "Altar";
  await ch.send(`@everyone ${label} in 1 hour! ${REMINDER_SUFFIX}`);

  state.notified[ev.key] = true;
  saveState();
}

async function tick() {
  const now = DateTime.now().setZone(TZ);

  for (const ev of events) {
    if (state.notified[ev.key]) continue;
    const diff = ev.startsAt.diff(now, "seconds").seconds;
    if (diff >= 3570 && diff <= 3630) {
      await sendReminder(ev);
    }
  }
}

/* ================= COMMANDS ================= */

function helpText() {
  return [
    "**Ruins / Altar Bot (UTC)**",
    "",
    "`-help` — show help",
    "`-status` — next event",
    "`-week` — next 7 days",
    "`-month` — next 1 month",
    "`-reload` — reload schedules",
    "",
    "Only users with the correct role can use commands."
  ].join("\n");
}

client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  if (!msg.content.startsWith(PREFIX)) return;
  if (!hasRole(msg.member)) return;

  const cmd = msg.content.slice(1).trim().toLowerCase();
  const now = DateTime.now().setZone(TZ);

  if (cmd === "help") return msg.reply(helpText());

  if (cmd === "reload") {
    loadAll();
    return msg.reply("✅ Reloaded schedules (UTC).");
  }

  if (cmd === "status") {
    const n = events.find(e => e.startsAt >= now);
    if (!n) return msg.reply("No upcoming events.");
    return msg.reply(`Next **${n.type.toUpperCase()}** at **${fmt(n.startsAt)}**`);
  }

  if (cmd === "week") {
    const end = now.plus({ days: 7 });
    const list = events.filter(e => e.startsAt >= now && e.startsAt <= end);
    return msg.reply(
      list.length
        ? list.map(e => `• **${e.type.toUpperCase()}** — ${fmt(e.startsAt)}`).join("\n")
        : "No events in next 7 days."
    );
  }

  if (cmd === "month") {
    const end = now.plus({ months: 1 });
    const list = events.filter(e => e.startsAt >= now && e.startsAt <= end);
    return msg.reply(
      list.length
        ? list.map(e => `• **${e.type.toUpperCase()}** — ${fmt(e.startsAt)}`).join("\n")
        : "No events in next 1 month."
    );
  }
});

/* ================= START ================= */

client.once("ready", () => {
  console.log(`[INFO] Logged in as ${client.user.tag}`);
  loadAll();
  setInterval(() => tick().catch(console.error), 30_000);
});

client.login(DISCORD_TOKEN);

/* ========== KEEP RAILWAY ALIVE ========== */

const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () =>
  console.log(`[INFO] HTTP server listening on ${PORT}`)
);

// EOF
