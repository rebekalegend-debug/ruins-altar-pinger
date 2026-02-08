import {
  Client,
  GatewayIntentBits,
  Partials
} from "discord.js";
import { DateTime } from "luxon";
import fs from "fs";
import path from "path";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;

// You said UTC always:
const TIMEZONE = "UTC";

// Optional: customize the tail text ("Send march!")
const REMINDER_SUFFIX = process.env.REMINDER_SUFFIX || "Send march!";

// Optional: command prefix
const PREFIX = process.env.PREFIX || "!";

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!ANNOUNCE_CHANNEL_ID) throw new Error("Missing ANNOUNCE_CHANNEL_ID");

const SCHEDULE_DIR = path.join(process.cwd(), "schedules");
const RUINS_FILE = path.join(SCHEDULE_DIR, "ruins.txt");
const ALTAR_FILE = path.join(SCHEDULE_DIR, "altar.txt");
const STATE_FILE = path.join(process.cwd(), "state.json");

// ---------------- state (avoid double pings) ----------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { notified: {} };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}
let state = loadState();

// ---------------- schedule parsing ----------------
function normalizeLine(line) {
  // Accept: "Mon, 12.1. 12:00" or "12.1. 12:00"
  return line
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[A-Za-z]{3},\s*/g, ""); // remove "Mon, "
}

function parseDateLineUTC(line) {
  const s = normalizeLine(line);
  if (!s) return null;

  // d.m. hh:mm (month has a dot after it in your format)
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const day = Number(m[1]);
  const month = Number(m[2]);
  const hour = Number(m[3]);
  const minute = Number(m[4]);

  const now = DateTime.now().setZone(TIMEZONE);

  // Yearless input: assume current year, else next year if it’s already passed.
  let dt = DateTime.fromObject(
    { year: now.year, month, day, hour, minute },
    { zone: TIMEZONE }
  );

  if (dt < now.minus({ minutes: 5 })) dt = dt.plus({ years: 1 });

  return dt;
}

function readScheduleFile(filePath, typeLabel) {
  if (!fs.existsSync(filePath)) return [];

  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const seen = new Set();
  const events = [];

  for (const line of lines) {
    const dt = parseDateLineUTC(line);
    if (!dt) {
      console.warn(`[WARN] Could not parse ${typeLabel}: "${line}"`);
      continue;
    }

    const key = `${typeLabel}:${dt.toISO()}`;
    if (seen.has(key)) continue; // de-dupe within file
    seen.add(key);

    events.push({ type: typeLabel, startsAt: dt, key });
  }

  events.sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis());
  return events;
}

let events = [];

function loadAllEvents() {
  if (!fs.existsSync(SCHEDULE_DIR)) fs.mkdirSync(SCHEDULE_DIR, { recursive: true });

  const ruins = readScheduleFile(RUINS_FILE, "ruins");
  const altar = readScheduleFile(ALTAR_FILE, "altar");

  events = [...ruins, ...altar].sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis());

  // Anti-spam cleanup: remove notifications older than 14 days
  const now = DateTime.now().setZone(TIMEZONE);
  const cutoff = now.minus({ days: 14 }).toMillis();
  for (const k of Object.keys(state.notified)) {
    const iso = k.split(":").slice(1).join(":");
    const t = DateTime.fromISO(iso, { zone: TIMEZONE }).toMillis();
    if (Number.isFinite(t) && t < cutoff) delete state.notified[k];
  }
  saveState(state);

  const ruinsCount = ruins.length;
  const altarCount = altar.length;
  console.log(`[INFO] Loaded events: ${events.length} (ruins=${ruinsCount}, altar=${altarCount}) TZ=${TIMEZONE}`);
  return { ruinsCount, altarCount, total: events.length };
}

function fmtUTC(dt) {
  return dt.setZone("UTC").toFormat("ccc dd.LL HH:mm") + " UTC";
}

function listUpcoming(range) {
  const now = DateTime.now().setZone(TIMEZONE);
  const end = now.plus(range);

  return events
    .filter((e) => e.startsAt >= now && e.startsAt <= end)
    .slice(0, 50);
}

// ---------------- Discord client ----------------
// Prefix commands require MESSAGE CONTENT access.
// In Dev Portal: enable "Message Content Intent" for the bot.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ---------------- Warning logic ----------------
async function sendWarning(ev) {
  const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) return;

  const label = ev.type === "ruins" ? "Ruins" : "Altar";
  await channel.send(`@everyone ${label} in 1 hour! ${REMINDER_SUFFIX}`);
  state.notified[ev.key] = true;
  saveState(state);
  console.log(`[INFO] Warned: ${ev.key}`);
}

async function schedulerTick() {
  const now = DateTime.now().setZone(TIMEZONE);

  for (const ev of events) {
    if (state.notified[ev.key]) continue;

    const diffSeconds = ev.startsAt.diff(now, "seconds").seconds;

    // 1 hour = 3600s, allow small jitter
    if (diffSeconds <= 3630 && diffSeconds >= 3570) {
      await sendWarning(ev);
    }
  }
}

// ---------------- Commands ----------------
function helpText() {
  return [
    "**Commands**",
    `\`${PREFIX}help\` — show this message`,
    `\`${PREFIX}status\` — show bot status + next event`,
    `\`${PREFIX}week\` — show upcoming schedules in the next 7 days (UTC)`,
    `\`${PREFIX}month\` — show upcoming schedules in the next 1 month (UTC)`,
    `\`${PREFIX}reload\` — reload schedules from schedules/*.txt (no spam)`,
    "",
    "**Schedule format (UTC):**",
    "`Mon, 12.1. 12:00`",
    "`Wed, 14.1. 4:00`",
    "",
    "**Notes:**",
    "- Bot pings exactly 1 hour before an event.",
    "- It will not ping the same event twice."
  ].join("\n");
}

function formatUpcomingLines(items) {
  if (items.length === 0) return "No upcoming events in that range.";

  const lines = items.map((e) => {
    const label = e.type === "ruins" ? "RUINS" : "ALTAR";
    const warnAt = e.startsAt.minus({ hours: 1 });
    return `• **${label}** opens: **${fmtUTC(e.startsAt)}** | warn: **${fmtUTC(warnAt)}**`;
  });

  // Discord message safety
  const text = lines.join("\n");
  return text.length > 1800 ? text.slice(0, 1800) + "\n…(trimmed)" : text;
}

function nextEvent() {
  const now = DateTime.now().setZone(TIMEZONE);
  return events.find((e) => e.startsAt >= now) || null;
}

client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;
    if (msg.author.bot) return;
    if (!msg.content.startsWith(PREFIX)) return;

    const [cmdRaw] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (cmdRaw || "").toLowerCase();

    if (cmd === "help") {
      await msg.reply(helpText());
      return;
    }

    if (cmd === "reload") {
      const counts = loadAllEvents();
      await msg.reply(`✅ Reloaded schedules (UTC). Ruins: **${counts.ruinsCount}**, Altar: **${counts.altarCount}**, Total: **${counts.total}**.`);
      return;
    }

    if (cmd === "week") {
      const items = listUpcoming({ days: 7 });
      await msg.reply(`**Upcoming (next 7 days, UTC)**\n${formatUpcomingLines(items)}`);
      return;
    }

    if (cmd === "month") {
      const items = listUpcoming({ months: 1 });
      await msg.reply(`**Upcoming (next 1**
