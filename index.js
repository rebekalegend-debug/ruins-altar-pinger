import { Client, GatewayIntentBits, Partials } from "discord.js";
import { DateTime } from "luxon";
import fs from "fs";
import path from "path";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID;

// Always UTC
const TIMEZONE = "UTC";

// Customization
const REMINDER_SUFFIX = process.env.REMINDER_SUFFIX || "Send march!";
const PREFIX = "!";

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!ANNOUNCE_CHANNEL_ID) throw new Error("Missing ANNOUNCE_CHANNEL_ID");

const SCHEDULE_DIR = path.join(process.cwd(), "schedules");
const RUINS_FILE = path.join(SCHEDULE_DIR, "ruins.txt");
const ALTAR_FILE = path.join(SCHEDULE_DIR, "altar.txt");
const STATE_FILE = path.join(process.cwd(), "state.json");

// ---------------- state ----------------
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
  return line.trim().replace(/\s+/g, " ").replace(/^[A-Za-z]{3},\s*/g, "");
}

function parseDateLineUTC(line) {
  const s = normalizeLine(line);
  if (!s) return null;

  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;

  const [_, d, mth, h, min] = m.map(Number);
  const now = DateTime.now().setZone(TIMEZONE);

  let dt = DateTime.fromObject(
    { year: now.year, month: mth, day: d, hour: h, minute: min },
    { zone: TIMEZONE }
  );

  if (dt < now.minus({ minutes: 5 })) dt = dt.plus({ years: 1 });
  return dt;
}

function readScheduleFile(filePath, type) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n");

  const seen = new Set();
  const events = [];

  for (const line of lines) {
    const dt = parseDateLineUTC(line);
    if (!dt) continue;

    const key = `${type}:${dt.toISO()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    events.push({ type, startsAt: dt, key });
  }

  return events.sort((a, b) => a.startsAt - b.startsAt);
}

let events = [];

function loadAllEvents() {
  if (!fs.existsSync(SCHEDULE_DIR)) fs.mkdirSync(SCHEDULE_DIR, { recursive: true });

  const ruins = readScheduleFile(RUINS_FILE, "ruins");
  const altar = readScheduleFile(ALTAR_FILE, "altar");

  events = [...ruins, ...altar].sort((a, b) => a.startsAt - b.startsAt);

  const now = DateTime.now().setZone(TIMEZONE);
  for (const k in state.notified) {
    const iso = k.split(":")[1];
    if (DateTime.fromISO(iso).diff(now, "days").days < -14) {
      delete state.notified[k];
    }
  }
  saveState(state);
}

// ---------------- Discord client ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ---------------- reminders ----------------
async function sendWarning(ev) {
  const channel = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
  if (!channel?.isTextBased()) return;

  const label = ev.type === "ruins" ? "Ruins" : "Altar";
  await channel.send(`@everyone ${label} in 1 hour! ${REMINDER_SUFFIX}`);
  state.notified[ev.key] = true;
  saveState(state);
}

async function schedulerTick() {
  const now = DateTime.now().setZone(TIMEZONE);

  for (const ev of events) {
    if (state.notified[ev.key]) continue;
    const diff = ev.startsAt.diff(now, "seconds").seconds;
    if (diff >= 3570 && diff <= 3630) await sendWarning(ev);
  }
}

// ---------------- commands ----------------
function fmt(dt) {
  return dt.toUTC().toFormat("ccc dd.LL HH:mm 'UTC'");
}

function helpText() {
  return [
    "**Ruins / Altar Bot (UTC)**",
    "",
    "`!!help` — show this message",
    "`!status` — next upcoming event",
    "`!week` — events in next 7 days",
    "`!month` — events in next 1 month",
    "`!reload` — reload schedules from GitHub",
    "",
    "Message format:",
    "`@everyone Ruins in 1 hour! Send march!`",
    "",
    "Times must be UTC."
  ].join("\n");
}

client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;

  // special double-prefix help
  if (msg.content.trim() === "!!help") {
    await msg.reply(helpText());
    return;
  }

  if (!msg.content.startsWith(PREFIX)) return;

  const cmd = msg.content.slice(1).trim().toLowerCase();

  if (cmd === "reload") {
    loadAllEvents();
    await msg.reply("✅ Schedules reloaded (UTC).");
  }

  if (cmd === "status") {
    const n = events.find((e) => e.startsAt > DateTime.now().toUTC());
    if (!n) return msg.reply("No upcoming events.");
    msg.reply(`Next **${n.type.toUpperCase()}** at **${fmt(n.startsAt)}**`);
  }

  if (cmd === "week") {
    const list = events.filter((e) =>
      e.startsAt <= DateTime.now().toUTC().plus({ days: 7 })
    );
    msg.reply(
      list.length
        ? list.map((e) => `• ${e.type.toUpperCase()} — ${fmt(e.startsAt)}`).join("\n")
        : "No events in next 7 days."
    );
  }

  if (cmd === "month") {
    const list = events.filter((e) =>
      e.startsAt <= DateTime.now().toUTC().plus({ months: 1 })
    );
    msg.reply(
      list.length
        ? list.map((e) => `• ${e.type.toUpperCase()} — ${fmt(e.startsAt)}`).join("\n")
        : "No events in next month."
    );
  }
});

client.once("ready", () => {
  console.log(`[INFO] Logged in as ${client.user.tag}`);
  loadAllEvents();
  setInterval(schedulerTick, 30_000);
});

client.login(DISCORD_TOKEN);
