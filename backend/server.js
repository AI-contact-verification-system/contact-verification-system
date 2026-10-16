// Voice bridge: Twilio ConversationRelay <-> OpenAI
// Twilio turns the caller's speech into text and sends it here.
// We ask OpenAI for a reply and send the text back; Twilio speaks it.

require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const OpenAI = require("openai");

const PORT = process.env.PORT || 8080;
const MODEL = "gpt-4o-mini";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Test contact. Later this will come from SharePoint.
const contact = {
  name: "Jordan Smith",
  company: "Peachtree Health Partners",
  jobTitle: "Operations Manager",
  email: "jordan.smith@example.com",
};

// Must match the welcomeGreeting in the curl command exactly.
const GREETING =
  "Hi, this is an AI assistant calling on behalf of Management Solutions Group. " +
  "You recently agreed to a short call to verify your contact information. Is now a good time?";

const SYSTEM_PROMPT = `You are an AI assistant calling on behalf of Management Solutions Group,
a healthcare consulting firm. You are on a phone call, so keep every reply to one or two short sentences.

You have already greeted the caller, said you are an AI assistant, stated the purpose,
and asked if now is a good time.

Contact info on file:
- Name: ${contact.name}
- Organization: ${contact.company}
- Job title: ${contact.jobTitle}
- Email: ${contact.email}

Steps, one question at a time:
1. Confirm they previously agreed to this call.
2. Confirm or update their preferred name.
3. Confirm or update their organization.
4. Confirm or update their job title.
5. Confirm or update their email address.
6. Ask their preferred way to be contacted (email, text, or phone).
7. Ask if they want to keep receiving occasional professional communications.
8. Thank them and say goodbye.

Rules:
- If they ask not to be contacted again, or say it is a bad time, apologize, confirm you will note it, and say goodbye.
- Never invent information. If something is unclear, ask them to repeat it.
- When you say goodbye, end your reply with the exact text [END].`;

// Basic HTTP response so you can check the server is running in a browser
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Voice bridge is running");
});

const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (ws) => {
  let callSid = "unknown";
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "assistant", content: GREETING },
  ];

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "setup") {
      callSid = msg.callSid;
      console.log(`\nCall connected: ${callSid}`);
      console.log(`AI: ${GREETING}`);
      return;
    }

    // Only respond to a finished sentence from the caller
    if (msg.type === "prompt" && msg.last !== false) {
      console.log(`Caller: ${msg.voicePrompt}`);
      messages.push({ role: "user", content: msg.voicePrompt });

      try {
        const completion = await openai.chat.completions.create({
          model: MODEL,
          messages,
        });
        let reply = completion.choices[0].message.content.trim();
        const isDone = reply.includes("[END]");
        reply = reply.replace("[END]", "").trim();

        messages.push({ role: "assistant", content: reply });
        console.log(`AI: ${reply}`);
        ws.send(JSON.stringify({ type: "text", token: reply, last: true }));

        if (isDone) {
          // Give Twilio a few seconds to finish speaking, then hang up
          setTimeout(() => ws.send(JSON.stringify({ type: "end" })), 6000);
        }
      } catch (err) {
        console.error("OpenAI error:", err.message);
        ws.send(
          JSON.stringify({
            type: "text",
            token: "Sorry, I'm having a technical issue. We'll follow up another time. Goodbye.",
            last: true,
          })
        );
      }
      return;
    }

    if (msg.type === "error") {
      console.error("Twilio reported an error:", msg.description || msg);
    }
  });

  ws.on("close", () => {
    // Save the conversation so it can be used for structured extraction later
    const dir = path.join(__dirname, "transcripts");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${callSid}.json`);
    const transcript = messages.filter((m) => m.role !== "system");
    fs.writeFileSync(file, JSON.stringify({ callSid, contact, transcript }, null, 2));
    console.log(`Call ended. Transcript saved to ${file}`);
  });
});

server.listen(PORT, () => {
  console.log(`Voice bridge listening on port ${PORT}`);
});
