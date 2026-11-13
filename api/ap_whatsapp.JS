/**
 * AgentZug V4.7 — /api/whatsapp
 * WhatsApp Business Cloud API Webhook (Meta Graph v21.0)
 *
 * Driven by SP-10 (Gemini Free Tier) + CEO-01 Escalation Governance:
 *  - Public CEA Business Line: +65 8980 9229 (Luiz Lee | CEA Reg No: R057632A | Huttons Asia Pte Ltd | L3008899K)
 *  - Conditional HDB MOP Calculator Link (https://hdb-mop-calculator.vercel.app) ONLY for HDB owners planning to sell/upgrade/downgrade
 *  - Dual-Number Urgent Escalation to +65 9237 9472 when Buyer Heat >= 80
 */

const CEA_SIGNATURE = "Luiz Lee | CEA Reg No: R057632A | Huttons Asia Pte Ltd | Licence No: L3008899K | +65 8980 9229";
const OWNER_ESCALATION_PHONE = process.env.OWNER_ESCALATION_WHATSAPP || "+65 9237 9472";
const HDB_MOP_URL = process.env.HDB_MOP_CALCULATOR_URL || "https://hdb-mop-calculator.vercel.app";

function evaluateInboundQualification(messageText) {
  const text = String(messageText || "").toLowerCase();
  const isHdbSeller = /(hdb|mop|5[-\s]?year|bto|resale flat|upgrade|downgrade|right[-\s]?size|sell.*flat|flat.*sell)/i.test(text);
  const hasIpaOrCash = /(ipa|in[-\s]?principle|approved|cash|cpf|budget|million|\$[0-9]|viewing|offer|otp)/i.test(text);
  const isUrgent = /(viewing|this week|tomorrow|urgent|ready to buy|otp|offer)/i.test(text);

  let heat = 45;
  if (isHdbSeller) heat += 20;
  if (hasIpaOrCash) heat += 20;
  if (isUrgent) heat += 15;
  heat = Math.min(100, heat);

  let reply = "";
  if (isHdbSeller) {
    reply = `Thank you for reaching out to Home Equity Studio! Before planning your HDB sale or upgrade, you can check your exact 5-year MOP date and net cash proceeds here: ${HDB_MOP_URL}\n\nCould you share your HDB town/flat type, estimated MOP year, and target next property budget?\n\n— ${CEA_SIGNATURE}`;
  } else {
    reply = `Thank you for contacting Home Equity Studio! To tailor verified URA REALIS benchmarks and available units for you, could you share your preferred district/property type, approximate budget, and whether you have a bank IPA ready?\n\n— ${CEA_SIGNATURE}`;
  }

  return {
    heat,
    isHdbSeller,
    mopCalculatorIncluded: isHdbSeller,
    escalateToOwner: heat >= 80,
    escalationTarget: heat >= 80 ? OWNER_ESCALATION_PHONE : null,
    reply
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // 1. Meta Webhook Verification (GET)
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];
    const expectedToken = process.env.WA_WEBHOOK_VERIFY_TOKEN || "luiz_lee_cea_verify_2026";

    if (mode === "subscribe" && token === expectedToken) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ ok: false, error: "Webhook verification failed" });
  }

  // 2. Inbound Message & Simulator Handler (POST)
  if (req.method === "POST") {
    const body = req.body || {};

    // Support both Meta Cloud API webhook payload and direct CRM test payload
    const entryMsg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const senderPhone = entryMsg?.from || body.senderPhone || "+65 9123 4567";
    const senderName = body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || body.senderName || "Inbound Prospect";
    const incomingText = entryMsg?.text?.body || body.message || "";

    if (!incomingText) {
      return res.status(200).json({ ok: true, ignored: true, reason: "No text body in webhook event" });
    }

    const qualification = evaluateInboundQualification(incomingText);

    // Optional live send via Meta Graph API v21.0 if configured
    const waPhoneId = process.env.WA_PHONE_NUMBER_ID;
    const waToken = process.env.WA_PERMANENT_ACCESS_TOKEN;
    let metaDispatched = false;

    if (waPhoneId && waToken && entryMsg?.from) {
      try {
        const graphResp = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(waPhoneId)}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${waToken}`
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: entryMsg.from,
            type: "text",
            text: { body: qualification.reply }
          })
        });
        metaDispatched = graphResp.ok;
      } catch (e) {
        metaDispatched = false;
      }
    }

    return res.status(200).json({
      ok: true,
      agent: "SP-10",
      senderName,
      senderPhone,
      incomingText,
      qualification,
      metaDispatched,
      ceaCompliance: CEA_SIGNATURE
    });
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
