/**
 * Long-poll Telegram and forward allowed chats to the local Alice server
 * started by `npm run alice` (BDK on 127.0.0.1:3000).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(join(root, ".env"));

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const allowed = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
);
const aliceUrl = (process.env.ALICE_URL || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const dataDir = join(root, "data");
const statePath = join(dataDir, "telegram-state.json");

if (!token) {
  console.error(
    "TELEGRAM_BOT_TOKEN is empty. Put the BotFather token in .env on this laptop, then restart npm run telegram.",
  );
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });
const state = loadState();
let sessionPrefix = null;

console.log(
  `Telegram bridge polling. Alice at ${aliceUrl}. Allowed chats: ${
    allowed.size ? [...allowed].join(",") : "(any — set TELEGRAM_ALLOWED_CHAT_IDS)"
  }`,
);

while (true) {
  try {
    const updates = await telegram("getUpdates", {
      timeout: 50,
      offset: state.offset,
      allowed_updates: ["message"],
    });
    for (const update of updates) {
      state.offset = update.update_id + 1;
      saveState();
      await handleUpdate(update);
    }
  } catch (error) {
    console.error(`poll error: ${error instanceof Error ? error.message : error}`);
    await sleep(5000);
  }
}

async function handleUpdate(update) {
  const message = update.message;
  const text = message?.text?.trim();
  const chatId = message?.chat?.id;
  if (!text || chatId == null || message.from?.is_bot) return;
  const chatKey = String(chatId);
  if (allowed.size > 0 && !allowed.has(chatKey)) {
    console.log(`ignored chat ${chatKey}`);
    return;
  }

  console.log(`chat ${chatKey}: ${text.slice(0, 80)}`);
  try {
    const reply = await askAlice(chatKey, text);
    await sendChunks(chatKey, reply || "(Alice returned an empty reply.)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`alice error for ${chatKey}: ${detail}`);
    await sendChunks(
      chatKey,
      "Alice is not answering right now. Check that `npm run alice` is running and that a Cursor API key is set on this laptop.",
    );
  }
}

async function askAlice(chatKey, text) {
  const prefix = await resolvePrefix();
  const saved = state.sessions[chatKey];
  let sessionId = saved?.sessionId;
  let continuationToken = saved?.continuationToken;
  let created = false;

  if (!sessionId) {
    const started = await postJson(`${prefix}/v1/session`, { message: text });
    sessionId = started.sessionId;
    continuationToken = started.continuationToken;
    created = true;
  } else {
    const followed = await postJson(`${prefix}/v1/session/${sessionId}`, {
      message: text,
      continuationToken,
    });
    if (followed.status === 409) {
      const started = await postJson(`${prefix}/v1/session`, { message: text });
      sessionId = started.sessionId;
      continuationToken = started.continuationToken;
      created = true;
    } else {
      continuationToken = followed.continuationToken || continuationToken;
    }
  }

  const startIndex = created ? 0 : Number(saved?.eventIndex) || 0;
  const { text: reply, eventIndex } = await readAssistantText(
    prefix,
    sessionId,
    startIndex,
  );
  state.sessions[chatKey] = { sessionId, continuationToken, eventIndex };
  saveState();
  return reply.trim();
}

async function resolvePrefix() {
  if (sessionPrefix) return sessionPrefix;
  const candidates = [aliceUrl, `${aliceUrl}/alice`];
  let lastError = "Alice did not respond";
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/v1/sessions`, {
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok) {
        sessionPrefix = candidate;
        console.log(`using Alice routes at ${candidate}`);
        return candidate;
      }
      lastError = `${candidate} returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(
    `Cannot reach Alice at ${aliceUrl} (${lastError}). Start it with npm run alice.`,
  );
}

async function readAssistantText(prefix, sessionId, startIndex = 0) {
  const response = await fetch(
    `${prefix}/v1/session/${sessionId}/stream?startIndex=${startIndex}`,
    { signal: AbortSignal.timeout(180000) },
  );
  if (!response.ok || !response.body) {
    throw new Error(`event stream returned ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let latest = "";
  let eventIndex = startIndex;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const event = JSON.parse(line);
        if (Number.isInteger(event.index)) eventIndex = event.index + 1;
        latest = noteReply(event, latest);
        if (isTerminal(event)) return { text: latest, eventIndex };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { text: latest, eventIndex };
}

function mergeText(previous, next) {
  if (!previous) return next;
  if (next.startsWith(previous) || previous.startsWith(next)) {
    return next.length >= previous.length ? next : previous;
  }
  return previous + next;
}

function noteReply(event, latest) {
  const data = event.data || {};
  if (event.type === "message.completed" && data.finishReason !== "tool_call" && data.text) {
    return data.text;
  }
  if (event.type === "message.appended") {
    const piece = data.text || data.delta || "";
    if (piece) return mergeText(latest, piece);
  }
  if (
    (event.type === "turn.completed" || event.type === "turn.failed") &&
    !latest &&
    (data.result || data.message)
  ) {
    return data.result || data.message;
  }
  return latest;
}

function isTerminal(event) {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "session.failed"
  );
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const json = await response.json().catch(() => ({}));
  if (response.status === 409) return { status: 409, ...json };
  if (!response.ok) {
    throw new Error(
      `${url} returned ${response.status} ${json.error || json.message || ""}`.trim(),
    );
  }
  return json;
}

async function sendChunks(chatId, text) {
  const chunks = [];
  let rest = text;
  while (rest.length > 4000) {
    chunks.push(rest.slice(0, 4000));
    rest = rest.slice(4000);
  }
  chunks.push(rest);
  for (const chunk of chunks) {
    await telegram("sendMessage", { chat_id: chatId, text: chunk });
  }
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === "getUpdates" ? 60000 : 20000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.description || `Telegram ${method} failed (${response.status})`);
  }
  return json.result;
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

function loadState() {
  if (!existsSync(statePath)) return { offset: 0, sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      offset: Number(parsed.offset) || 0,
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    };
  } catch {
    return { offset: 0, sessions: {} };
  }
}

function saveState() {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
