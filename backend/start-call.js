// start-call.js - test helper. Places a call to one contact from demo-contacts.json
// Usage:  npm run call -- DEMO-001
// Set BRIDGE_URL in .env to call the Azure bridge instead of your laptop.
// (Later, Power Automate sends this same request instead of this script.)

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const id = process.argv[2];
const file = path.join(__dirname, "demo-contacts.json");

if (!fs.existsSync(file)) {
  console.error("demo-contacts.json not found. Copy demo-contacts.example.json to demo-contacts.json and fill it in.");
  process.exit(1);
}
const contacts = JSON.parse(fs.readFileSync(file, "utf8"));

if (!id) {
  console.log("Usage: npm run call -- <CustomerID>\nAvailable:");
  contacts.forEach((c) => console.log(`  ${c.CustomerID}  ${c.Name}`));
  process.exit(0);
}

const contact = contacts.find((c) => c.CustomerID === id);
if (!contact) {
  console.error(`No contact with CustomerID ${id} in demo-contacts.json`);
  process.exit(1);
}

const base = process.env.BRIDGE_URL || `http://localhost:${process.env.PORT || 8080}`;
console.log(`Sending call request to ${base}`);

fetch(`${base}/start-call`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": process.env.BRIDGE_API_KEY },
  body: JSON.stringify({ contact }),
})
  .then(async (r) => console.log(`HTTP ${r.status}:`, await r.json()))
  .catch((err) => console.error("Could not reach the bridge. Is npm start running?", err.message));
