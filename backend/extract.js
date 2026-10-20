// extract.js - turns a finished call transcript into structured results
// that match the Review & Approval screen (original value vs AI-proposed value).

const FIELDS = ["Name", "Company", "JobTitle", "Email", "Phone"];

// The exact shape OpenAI must return (enforced with Structured Outputs)
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "identityConfirmed", "outcome", "optOutRequested",
    "preferredContactMethod", "continueCommunications", "summary", "fields",
  ],
  properties: {
    identityConfirmed: { type: "boolean" },
    outcome: {
      type: "string",
      enum: ["Completed", "WrongPerson", "CallbackRequested", "OptedOut", "Voicemail", "Incomplete"],
    },
    optOutRequested: { type: "boolean" },
    preferredContactMethod: { type: "string", enum: ["Email", "Text", "Phone", "NotStated"] },
    continueCommunications: { type: "string", enum: ["Yes", "No", "NotStated"] },
    summary: { type: "string" },
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fieldName", "status", "proposedValue", "note"],
        properties: {
          fieldName: { type: "string", enum: FIELDS },
          status: { type: "string", enum: ["Confirmed", "Updated", "Unclear", "NotDiscussed"] },
          proposedValue: { type: "string" },
          note: { type: "string" },
        },
      },
    },
  },
};

const INSTRUCTIONS = `You review transcripts of contact-verification phone calls made by an AI assistant.
Return what the caller confirmed or changed. Be strict: only report what the caller actually said.

For each of these fields, return exactly one entry: ${FIELDS.join(", ")}.
- "Confirmed": the caller said the value on file is correct. proposedValue = "".
- "Updated": the caller clearly gave a different value AND confirmed it when it was read back. proposedValue = the new value.
- "Unclear": the caller gave a different value but it was never clearly confirmed, or the transcript is ambiguous. proposedValue = your best reading; explain in note.
- "NotDiscussed": the field never came up. proposedValue = "".

Formatting for proposedValue:
- Email: standard form, lowercase, no spaces. "j holmes at gmail dot com" becomes "jholmes@gmail.com".
- Phone: digits only, e.g. "4706588767".
- Names, companies, job titles: normal capitalization.

Other fields:
- identityConfirmed: true only if the person confirmed they are the contact.
- outcome: Completed (finished verification), WrongPerson, CallbackRequested (bad time), OptedOut (asked not to be contacted), Voicemail, or Incomplete (call ended early for another reason).
- optOutRequested: true if they asked not to be contacted again in any way.
- summary: two or three plain sentences for the administrator describing what happened on the call.
If identity was not confirmed, mark every field NotDiscussed.`;

function normalize(field, value) {
  const v = (value || "").trim();
  if (field === "Email") return v.toLowerCase().replace(/\s+/g, "");
  if (field === "Phone") {
    const d = v.replace(/\D/g, "");
    return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  }
  return v.toLowerCase().replace(/\s+/g, " ");
}

async function extractResults(openai, model, contact, transcript) {
  const transcriptText = transcript
    .map((m) => `${m.role === "assistant" ? "AI" : "Caller"}: ${m.content}`)
    .join("\n");

  const onFile = FIELDS.map((f) => `${f}: ${contact[f] || "(blank)"}`).join("\n");

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: `CONTACT ON FILE:\n${onFile}\n\nTRANSCRIPT:\n${transcriptText}` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "verification_result", strict: true, schema: SCHEMA },
    },
  });

  const result = JSON.parse(completion.choices[0].message.content);

  // Build one ProposedChanges row per field that needs an administrator decision.
  // A "change" that matches what is already on file is treated as Confirmed.
  const proposedChanges = [];
  for (const f of result.fields) {
    if (f.status !== "Updated" && f.status !== "Unclear") continue;
    if (normalize(f.fieldName, f.proposedValue) === normalize(f.fieldName, contact[f.fieldName])) {
      f.status = "Confirmed";
      continue;
    }
    proposedChanges.push({
      CustomerID: contact.CustomerID,
      FieldName: f.fieldName,
      OriginalValue: contact[f.fieldName] || "",
      ProposedValue: f.proposedValue,
      Confidence: f.status === "Updated" ? "Confirmed by caller" : "Needs extra review",
      Note: f.note,
      ReviewStatus: "Pending",
    });
  }

  return { ...result, proposedChanges };
}

module.exports = { extractResults, FIELDS };
