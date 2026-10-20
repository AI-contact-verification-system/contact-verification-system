// Voice bridge: places verification calls with Twilio and lets OpenAI hold the conversation.
//
//   POST /start-call   { contact }      -> places a call (needs x-api-key header)
//   POST /call-status  (from Twilio)    -> records no-answer / busy / failed calls
//   WS   /relay        (from Twilio)    -> the live conversation
//
// When a call ends, results are saved to results/ and, if RESULTS_WEBHOOK_URL is set,
// sent to that URL (later: the Power Automate flow that writes to SharePoint).

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const OpenAI = require("openai");
const { buildGreeting, buildSystemPrompt } = require("./script");
const { extractResults } = require("./extract");

const {
  PORT = 8080,
  PUBLIC_HOST,
  BRIDGE_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  ALLOWED_NUMBERS = "",
  RESULTS_WEBHOOK_URL,
  TWILIO_API_BASE = "https://api.twilio.com",
} = process.env;

const MODEL = "gpt-4o-mini";
const MAX_TURNS = 40; // safety limit on conversation length
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Only these numbers may ever be called. Empty list = nothing can be called.
const allowed = new Set(ALLOWED_NUMBERS.split(",").map((n) => toE164(n)).filter(Boolean));

// Calls waiting to connect, keyed by Twilio's CallSid
const pendingCalls = new Map();

// ---------- helpers ----------

function toE164(raw) {
  let d = (raw || "").split(/x|ext/i)[0].replace(/\D/g, "");
  if (d.length === 10) d = "1" + d;
  return d.length === 11 && d.startsWith("1") ? `+${d}` : null;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function saveResult(result) {
  const dir = path.join(__dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${result.CustomerID}_${result.CallSid}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`Result saved: ${file}`);

  if (RESULTS_WEBHOOK_URL) {
    try {
      const r = await fetch(RESULTS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
      console.log(`Results sent to webhook: HTTP ${r.status}`);
    } catch (err) {
      console.error("Could not send results to webhook:", err.message);
    }
  }
}

// ---------- placing a call ----------

async function startCall(contact) {
  const to = toE164(contact.Phone);
  if (!to) throw { status: 400, message: `Phone number is not a valid US number: ${contact.Phone}` };
  if (!allowed.has(to)) throw { status: 403, message: `${to} is not in ALLOWED_NUMBERS. Call refused.` };

  const twiml =
    `<Response><Connect>` +
    `<ConversationRelay url="wss://${PUBLIC_HOST}/relay" welcomeGreeting="${xmlEscape(buildGreeting(contact))}" />` +
    `</Connect></Response>`;

  const body = new URLSearchParams({
    To: to,
    From: TWILIO_FROM_NUMBER,
    Twiml: twiml,
    Timeout: "30",
    StatusCallback: `https://${PUBLIC_HOST}/call-status`,
  });

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const r = await fetch(`${TWILIO_API_BASE}/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw { status: 502, message: `Twilio error ${data.code}: ${data.message}` };

  pendingCalls.set(data.sid, { contact, startedAt: new Date().toISOString(), connected: false });
  console.log(`\nCalling ${contact.Name} (${contact.CustomerID}) - CallSid ${data.sid}`);
  return data.sid;
}

// ---------- HTTP routes ----------

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Voice bridge is running");
  }

  if (req.method === "POST" && req.url === "/start-call") {
    if (!BRIDGE_API_KEY || req.headers["x-api-key"] !== BRIDGE_API_KEY) {
      return send(res, 401, { error: "Missing or wrong x-api-key" });
    }
    try {
      const { contact } = JSON.parse(await readBody(req));
      if (!contact || !contact.CustomerID || !contact.Name || !contact.Phone) {
        return send(res, 400, { error: "contact needs at least CustomerID, Name, and Phone" });
      }
      const callSid = await startCall(contact);
      return send(res, 200, { status: "calling", callSid, CustomerID: contact.CustomerID });
    } catch (err) {
      console.error("Start call failed:", err.message || err);
      return send(res, err.status || 500, { error: err.message || "Could not start call" });
    }
  }

  // Twilio reports the final status of every call here
  if (req.method === "POST" && req.url === "/call-status") {
    const p = new URLSearchParams(await readBody(req));
    const sid = p.get("CallSid");
    const status = p.get("CallStatus");
    const call = pendingCalls.get(sid);
    if (call && !call.connected && ["no-answer", "busy", "failed", "canceled"].includes(status)) {
      pendingCalls.delete(sid);
      console.log(`Call ${sid} ended without a conversation: ${status}`);
      await saveResult({
        CustomerID: call.contact.CustomerID,
        CallSid: sid,
        outcome: "NoAnswer",
        callStatus: status,
        startedAt: call.startedAt,
        completedAt: new Date().toISOString(),
        proposedChanges: [],
      });
    }
    res.writeHead(204);
    return res.end();
  }

  send(res, 404, { error: "Not found" });
});

// ---------- the live conversation ----------

const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (ws) => {
  let callSid = null;
  let call = null;
  let messages = [];
  let ending = false;

  const say = (text) => ws.send(JSON.stringify({ type: "text", token: text, last: true }));
  const hangUp = (delayMs) => {
    if (ending) return;
    ending = true;
    setTimeout(() => ws.send(JSON.stringify({ type: "end" })), delayMs);
  };

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "setup") {
      callSid = msg.callSid;
      call = pendingCalls.get(callSid);
      if (!call) {
        console.log(`Unknown call ${callSid} - no contact details. Ending.`);
        say("Sorry, I don't have the details for this call. Goodbye.");
        return hangUp(4000);
      }
      call.connected = true;
      const greeting = buildGreeting(call.contact);
      messages = [
        { role: "system", content: buildSystemPrompt(call.contact) },
        { role: "assistant", content: greeting },
      ];
      console.log(`Connected: ${call.contact.Name}\nAI: ${greeting}`);
      return;
    }

    if (msg.type === "prompt" && msg.last !== false && call && !ending) {
      console.log(`Caller: ${msg.voicePrompt}`);
      messages.push({ role: "user", content: msg.voicePrompt });

      try {
        const completion = await openai.chat.completions.create({ model: MODEL, messages });
        let reply = completion.choices[0].message.content.trim();
        const done = reply.includes("[END]") || messages.length > MAX_TURNS;
        reply = reply.replace("[END]", "").trim();

        if (reply) {
          messages.push({ role: "assistant", content: reply });
          console.log(`AI: ${reply}`);
          say(reply);
        }
        if (done) hangUp(reply ? 7000 : 500);
      } catch (err) {
        console.error("OpenAI error:", err.message);
        say("Sorry, I'm having a technical issue. Someone may follow up another time. Goodbye.");
        hangUp(6000);
      }
      return;
    }

    if (msg.type === "error") console.error("Twilio reported an error:", msg.description || msg);
  });

  ws.on("close", async () => {
    if (!call) return;
    pendingCalls.delete(callSid);
    const transcript = messages.filter((m) => m.role !== "system");
    console.log("Call ended. Extracting results...");

    let extracted;
    try {
      extracted = await extractResults(openai, MODEL, call.contact, transcript);
    } catch (err) {
      console.error("Extraction failed:", err.message);
      extracted = { outcome: "Incomplete", summary: "Automatic extraction failed. Review the transcript.", proposedChanges: [] };
    }

    await saveResult({
      CustomerID: call.contact.CustomerID,
      CallSid: callSid,
      startedAt: call.startedAt,
      completedAt: new Date().toISOString(),
      ...extracted,
      transcript,
    });
  });
});

// ---------- start ----------

const missing = ["OPENAI_API_KEY", "PUBLIC_HOST", "BRIDGE_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing settings in .env: ${missing.join(", ")}`);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`Voice bridge listening on port ${PORT}`);
  console.log(`Public address: https://${PUBLIC_HOST}`);
  console.log(`Numbers allowed to be called: ${[...allowed].join(", ") || "NONE (set ALLOWED_NUMBERS)"}`);
});
