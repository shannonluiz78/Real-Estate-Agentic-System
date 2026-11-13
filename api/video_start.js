/**
 * AgentZug V4.7 — /api/video/start
 * Live Gemini Omni 1.2 Flash (gemini-omni-1.2-flash) Async Video Starter
 *
 * - Calls https://generativelanguage.googleapis.com/v1beta/models/gemini-omni-1.2-flash:predictLongRunning
 *   using GEMINI_API_KEY.
 * - When mode === "AVATAR_REF", attaches the uploaded advisor headshot as an inlineData reference image
 *   alongside the scene's spoken script and prompt.
 * - Surfaces exact HTTP status codes and Google API error messages if the call fails or is unavailable
 *   on the current key (never silently masking errors as "Ready").
 */

const CREDIT_LIMIT_SGD = parseFloat(process.env.MONTHLY_CLOUD_CREDIT_LIMIT_SGD || "12.83");
const BACKUP_TRIGGER_SGD = parseFloat(process.env.MANUAL_BACKUP_TRIGGER_SGD || "11.50");
const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";

function estimateSceneCostSgd(durationSec = 10, mode = "AVATAR_REF") {
  const dur = Math.min(15, Math.max(8, Number(durationSec) || 10));
  const ratePerSec = mode === "AVATAR_REF" ? 0.035 : 0.025;
  return Number((dur * ratePerSec).toFixed(2));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const {
    sceneIndex = 0,
    sceneTitle = "Scene 1: Hook",
    prompt = "",
    spokenScript = "",
    durationSec = 10,
    mode = "AVATAR_REF", // "AVATAR_REF" | "BROLL"
    advisorAvatarDataUri = null,
    currentSpendSgd = 3.42
  } = req.body || {};

  const spend = Number(currentSpendSgd || 0);
  const estCost = estimateSceneCostSgd(durationSec, mode);

  // SP-12 Credit Cap Guardrail
  if (spend >= CREDIT_LIMIT_SGD || (spend + estCost) > CREDIT_LIMIT_SGD) {
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      httpStatus: 402,
      error: `SP-12 Credit Cap (S$${CREDIT_LIMIT_SGD.toFixed(2)}/mo) reached — use Manual Backup Flow`,
      model: OMNI_VIDEO_MODEL,
      triggerManualBackupDrawer: true
    });
  }

  const geminiKey = process.env.GEMINI_API_KEY || "";
  if (!geminiKey) {
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      httpStatus: 401,
      error: "HTTP 401: GEMINI_API_KEY missing in Vercel .env",
      model: OMNI_VIDEO_MODEL
    });
  }

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(OMNI_VIDEO_MODEL)}:predictLongRunning?key=${encodeURIComponent(geminiKey)}`;

    const fullPrompt = spokenScript
      ? `${prompt}\nSpoken Dialogue (45yo Singaporean Chinese male English advisor, warm baritone): "${spokenScript}"\nStrictly no burned-in text, no captions, no watermarks, no logos.`
      : `${prompt}\nStrictly no burned-in text, no captions, no watermarks, no logos.`;

    const instancePayload = {
      prompt: fullPrompt
    };

    // Pass uploaded advisor headshot as inlineData reference image when in Advisor Avatar Reference mode
    if (mode === "AVATAR_REF" && advisorAvatarDataUri && advisorAvatarDataUri.startsWith("data:image/")) {
      const match = advisorAvatarDataUri.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        instancePayload.image = {
          inlineData: {
            mimeType: match[1],
            data: match[2]
          }
        };
      }
    }

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [instancePayload],
        parameters: {
          aspectRatio: "9:16",
          durationSeconds: Math.min(15, Math.max(8, Number(durationSec) || 10)),
          personGeneration: mode === "AVATAR_REF" ? "allow_adult" : "dont_allow"
        }
      })
    });

    if (!resp.ok) {
      let apiErrMsg = `HTTP ${resp.status}`;
      try {
        const errJson = await resp.json();
        const detail = errJson?.error?.message || JSON.stringify(errJson);
        apiErrMsg = `HTTP ${resp.status}: ${detail.slice(0, 180)}`;
      } catch (e) {
        const errTxt = await resp.text().catch(() => "");
        apiErrMsg = `HTTP ${resp.status}: ${errTxt.slice(0, 180) || resp.statusText}`;
      }

      return res.status(200).json({
        ok: false,
        status: "FAILED",
        httpStatus: resp.status,
        error: apiErrMsg,
        model: OMNI_VIDEO_MODEL,
        sceneIndex
      });
    }

    const opData = await resp.json();
    if (!opData || !opData.name) {
      return res.status(200).json({
        ok: false,
        status: "FAILED",
        httpStatus: 502,
        error: "HTTP 502: Gemini API did not return an async operation name",
        model: OMNI_VIDEO_MODEL,
        sceneIndex
      });
    }

    return res.status(200).json({
      ok: true,
      status: "RUNNING",
      source: OMNI_VIDEO_MODEL,
      operationId: opData.name,
      model: OMNI_VIDEO_MODEL,
      sceneIndex,
      sceneTitle,
      mode,
      durationSec,
      estimatedCostSgd: estCost,
      triggerManualBackupDrawer: (spend + estCost) >= BACKUP_TRIGGER_SGD
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      httpStatus: 500,
      error: `HTTP 500: ${err.message || "Network error calling gemini-omni-1.2-flash"}`,
      model: OMNI_VIDEO_MODEL,
      sceneIndex
    });
  }
}
