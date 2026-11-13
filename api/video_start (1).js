/**
 * AgentZug V4.7 — api/video/start.js
 * Vercel Serverless Function for /api/video/start (Static Root Deployment)
 *
 * Calls Google Gemini API (`generativelanguage.googleapis.com/v1beta/models/gemini-omni-1.2-flash:generateContent`,
 * with automatic fallback to `:predictLongRunning`). Logs and forwards exact upstream Gemini API status and
 * response body if rejected.
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
    mode = "AVATAR_REF",
    advisorAvatarDataUri = null,
    currentSpendSgd = 3.42
  } = req.body || {};

  const spend = Number(currentSpendSgd || 0);
  const estCost = estimateSceneCostSgd(durationSec, mode);

  if (spend >= CREDIT_LIMIT_SGD || (spend + estCost) > CREDIT_LIMIT_SGD) {
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      upstreamStatus: 402,
      error: `SP-12 Credit Cap (S$${CREDIT_LIMIT_SGD.toFixed(2)}/mo) reached — use Manual Backup Flow`,
      model: OMNI_VIDEO_MODEL,
      triggerManualBackupDrawer: true
    });
  }

  const geminiKey = process.env.GEMINI_API_KEY || "";
  if (!geminiKey) {
    console.error("[/api/video/start] Missing GEMINI_API_KEY in server environment");
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      upstreamStatus: 401,
      error: "Upstream Gemini HTTP 401: GEMINI_API_KEY is missing in Vercel environment variables",
      model: OMNI_VIDEO_MODEL
    });
  }

  try {
    const clampedDur = Math.min(15, Math.max(8, Number(durationSec) || 10));
    const fullPrompt = spokenScript
      ? `${prompt}\nSpoken Dialogue (45yo Singaporean Chinese male English advisor, warm baritone, ${clampedDur}s): "${spokenScript}"\nTarget aspect ratio: 9:16 vertical. Strictly no burned-in text, no captions, no watermarks, no logos.`
      : `${prompt}\nTarget aspect ratio: 9:16 vertical, duration ${clampedDur}s. Strictly no burned-in text, no captions, no watermarks, no logos.`;

    const parts = [{ text: fullPrompt }];
    let inlineImageObj = null;

    if (mode === "AVATAR_REF" && advisorAvatarDataUri && advisorAvatarDataUri.startsWith("data:image/")) {
      const match = advisorAvatarDataUri.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        inlineImageObj = { mimeType: match[1], data: match[2] };
        parts.push({ inlineData: inlineImageObj });
      }
    }

    // 1. Primary Attempt: Official Gemini v1beta :generateContent endpoint supported by GEMINI_API_KEY
    const gcUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(OMNI_VIDEO_MODEL)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
    const gcResp = await fetch(gcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.4 }
      })
    });

    const gcRawText = await gcResp.text();
    let gcParsed = {};
    try { gcParsed = JSON.parse(gcRawText); } catch (e) { gcParsed = { rawBody: gcRawText }; }

    if (gcResp.ok) {
      const respParts = gcParsed?.candidates?.[0]?.content?.parts || [];
      const mediaPart = respParts.find(p => p?.inlineData?.data || p?.fileData?.fileUri);

      if (mediaPart?.inlineData?.data) {
        const mimeType = mediaPart.inlineData.mimeType || "video/mp4";
        return res.status(200).json({
          ok: true,
          status: "DONE",
          source: OMNI_VIDEO_MODEL,
          endpointUsed: "generateContent",
          model: OMNI_VIDEO_MODEL,
          sceneIndex,
          sceneTitle,
          mode,
          durationSec: clampedDur,
          videoDataUri: `data:${mimeType};base64,${mediaPart.inlineData.data}`,
          estimatedCostSgd: estCost,
          triggerManualBackupDrawer: (spend + estCost) >= BACKUP_TRIGGER_SGD
        });
      }

      if (mediaPart?.fileData?.fileUri) {
        const rawUri = String(mediaPart.fileData.fileUri);
        const sep = rawUri.includes("?") ? "&" : "?";
        const fetchableUrl = rawUri.includes("generativelanguage.googleapis.com")
          ? `${rawUri}${sep}key=${encodeURIComponent(geminiKey)}`
          : rawUri;
        return res.status(200).json({
          ok: true,
          status: "DONE",
          source: OMNI_VIDEO_MODEL,
          endpointUsed: "generateContent",
          model: OMNI_VIDEO_MODEL,
          sceneIndex,
          sceneTitle,
          mode,
          durationSec: clampedDur,
          videoUrl: fetchableUrl,
          estimatedCostSgd: estCost,
          triggerManualBackupDrawer: (spend + estCost) >= BACKUP_TRIGGER_SGD
        });
      }

      if (gcParsed?.name) {
        return res.status(200).json({
          ok: true,
          status: "RUNNING",
          source: OMNI_VIDEO_MODEL,
          endpointUsed: "generateContent",
          operationId: gcParsed.name,
          model: OMNI_VIDEO_MODEL,
          sceneIndex,
          estimatedCostSgd: estCost
        });
      }
    }

    console.error("[/api/video/start] Upstream :generateContent rejected:", {
      model: OMNI_VIDEO_MODEL,
      status: gcResp.status,
      body: gcParsed
    });

    const gcErrDetail = gcParsed?.error?.message || gcRawText.slice(0, 240);

    // 2. Secondary Attempt: Try :predictLongRunning if :generateContent returned 400 or 404
    if (gcResp.status === 400 || gcResp.status === 404) {
      const plrUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(OMNI_VIDEO_MODEL)}:predictLongRunning?key=${encodeURIComponent(geminiKey)}`;
      const instancePayload = { prompt: fullPrompt };
      if (inlineImageObj) instancePayload.image = { inlineData: inlineImageObj };

      const plrResp = await fetch(plrUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [instancePayload],
          parameters: {
            aspectRatio: "9:16",
            durationSeconds: clampedDur
          }
        })
      });

      const plrRawText = await plrResp.text();
      let plrParsed = {};
      try { plrParsed = JSON.parse(plrRawText); } catch (e) { plrParsed = { rawBody: plrRawText }; }

      if (plrResp.ok && plrParsed?.name) {
        return res.status(200).json({
          ok: true,
          status: "RUNNING",
          source: OMNI_VIDEO_MODEL,
          endpointUsed: "predictLongRunning",
          operationId: plrParsed.name,
          model: OMNI_VIDEO_MODEL,
          sceneIndex,
          sceneTitle,
          mode,
          durationSec: clampedDur,
          estimatedCostSgd: estCost,
          triggerManualBackupDrawer: (spend + estCost) >= BACKUP_TRIGGER_SGD
        });
      }

      console.error("[/api/video/start] Upstream :predictLongRunning rejected:", {
        model: OMNI_VIDEO_MODEL,
        status: plrResp.status,
        body: plrParsed
      });

      const plrErrDetail = plrParsed?.error?.message || plrRawText.slice(0, 240);
      return res.status(200).json({
        ok: false,
        status: "FAILED",
        upstreamStatus: gcResp.status,
        upstreamEndpoint: `models/${OMNI_VIDEO_MODEL}:generateContent`,
        upstreamBody: gcParsed,
        fallbackAttemptStatus: plrResp.status,
        fallbackAttemptBody: plrParsed,
        error: `Upstream Gemini HTTP ${gcResp.status} (${OMNI_VIDEO_MODEL}): ${gcErrDetail || plrErrDetail}`
      });
    }

    return res.status(200).json({
      ok: false,
      status: "FAILED",
      upstreamStatus: gcResp.status,
      upstreamEndpoint: `models/${OMNI_VIDEO_MODEL}:generateContent`,
      upstreamBody: gcParsed,
      error: `Upstream Gemini HTTP ${gcResp.status} (${OMNI_VIDEO_MODEL}): ${gcErrDetail}`
    });
  } catch (err) {
    console.error("[/api/video/start] Unhandled exception:", err);
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      upstreamStatus: 500,
      error: `Upstream Gemini HTTP 500: ${err.message || "Network error calling gemini-omni-1.2-flash"}`
    });
  }
}
