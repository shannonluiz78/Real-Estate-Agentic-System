/**
 * AgentZug V4.7 — api/video/start.js
 * Google Gemini Interactions API Video Starter for gemini-omni-1.2-flash
 */

const CREDIT_LIMIT_SGD = parseFloat(process.env.MONTHLY_CLOUD_CREDIT_LIMIT_SGD || "12.83");
const BACKUP_TRIGGER_SGD = parseFloat(process.env.MANUAL_BACKUP_TRIGGER_SGD || "11.50");
const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";
const INTERACTIONS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

function estimateSceneCostSgd(durationSec = 10, mode = "AVATAR_REF") {
  const dur = Math.min(15, Math.max(8, Number(durationSec) || 10));
  const ratePerSec = mode === "AVATAR_REF" ? 0.035 : 0.025;
  return Number((dur * ratePerSec).toFixed(2));
}

function extractVideoFromInteraction(interaction, geminiKey) {
  const outputs = Array.isArray(interaction?.outputs) ? interaction.outputs : [];
  for (const item of outputs) {
    const itemType = String(item?.type || "").toLowerCase();
    const mimeType = String(item?.mime_type || item?.mimeType || "video/mp4");
    if (itemType === "video" || mimeType.startsWith("video/")) {
      if (typeof item?.data === "string" && item.data) {
        return { videoDataUri: `data:${mimeType};base64,${item.data}`, videoUrl: null };
      }
      const rawUri = item?.uri || item?.url || item?.file_uri || item?.fileUri;
      if (rawUri) {
        const sep = rawUri.includes("?") ? "&" : "?";
        const videoUrl = rawUri.includes("generativelanguage.googleapis.com")
          ? `${rawUri}${sep}key=${encodeURIComponent(geminiKey)}`
          : rawUri;
        return { videoUrl, videoDataUri: null };
      }
    }
  }
  return { videoUrl: null, videoDataUri: null };
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
      error: "Interactions API HTTP 401: GEMINI_API_KEY is missing in Vercel environment variables",
      model: OMNI_VIDEO_MODEL
    });
  }

  try {
    const clampedDur = Math.min(15, Math.max(8, Number(durationSec) || 10));
    const durationTag = `${clampedDur}s`;
    const aspectRatio = "9:16";

    const fullPrompt = spokenScript
      ? `${prompt}\nSpoken Dialogue (45yo Singaporean Chinese male English advisor, warm baritone, ${durationTag}): "${spokenScript}"\nTarget Format: ${aspectRatio} vertical video, duration ${durationTag}. Strictly no burned-in text, no captions, no watermarks, no logos.`
      : `${prompt}\nTarget Format: ${aspectRatio} vertical video, duration ${durationTag}. Strictly no burned-in text, no captions, no watermarks, no logos.`;

    const inputContent = [{ type: "text", text: fullPrompt }];

    if (mode === "AVATAR_REF" && typeof advisorAvatarDataUri === "string" && advisorAvatarDataUri.startsWith("data:image/")) {
      const match = advisorAvatarDataUri.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        inputContent.push({
          type: "image",
          data: match[2],
          mime_type: match[1]
        });
      }
    }

    const resp = await fetch(INTERACTIONS_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiKey
      },
      body: JSON.stringify({
        model: OMNI_VIDEO_MODEL,
        input: inputContent,
        background: true,
        store: true,
        response_modalities: ["video"],
        generation_config: {
          temperature: 0.4
        }
      })
    });

    const rawText = await resp.text();
    let parsed = {};
    try { parsed = JSON.parse(rawText); } catch (e) { parsed = { rawBody: rawText }; }

    if (!resp.ok) {
      console.error("[/api/video/start] Gemini Interactions API rejected request:", {
        endpoint: INTERACTIONS_BASE_URL,
        model: OMNI_VIDEO_MODEL,
        status: resp.status,
        body: parsed
      });
      const detail = parsed?.error?.message || rawText.slice(0, 240) || resp.statusText;
      return res.status(200).json({
        ok: false,
        status: "FAILED",
        upstreamStatus: resp.status,
        upstreamBody: parsed,
        error: `Interactions API HTTP ${resp.status} (${OMNI_VIDEO_MODEL}): ${detail}`
      });
    }

    const interactionId = String(parsed?.id || parsed?.name || "").trim();
    const interactionStatus = String(parsed?.status || "in_progress").toLowerCase();

    if (!interactionId) {
      return res.status(200).json({
        ok: false,
        status: "FAILED",
        upstreamStatus: 502,
        upstreamBody: parsed,
        error: "Interactions API HTTP 502: Missing interaction.id in response"
      });
    }

    if (interactionStatus === "completed") {
      const media = extractVideoFromInteraction(parsed, geminiKey);
      if (media.videoDataUri || media.videoUrl) {
        return res.status(200).json({
          ok: true,
          status: "DONE",
          interactionId,
          operationId: interactionId,
          interactionStatus,
          source: OMNI_VIDEO_MODEL,
          model: OMNI_VIDEO_MODEL,
          sceneIndex,
          sceneTitle,
          mode,
          durationSec: clampedDur,
          videoUrl: media.videoUrl,
          videoDataUri: media.videoDataUri,
          estimatedCostSgd: estCost,
          triggerManualBackupDrawer: (spend + estCost) >= BACKUP_TRIGGER_SGD
        });
      }
    }

    return res.status(200).json({
      ok: true,
      status: "RUNNING",
      interactionId,
      operationId: interactionId,
      interactionStatus,
      source: OMNI_VIDEO_MODEL,
      model: OMNI_VIDEO_MODEL,
      sceneIndex,
      sceneTitle,
      mode,
      durationSec: clampedDur,
      estimatedCostSgd: estCost,
      triggerManualBackupDrawer: (spend + estCost) >= BACKUP_TRIGGER_SGD
    });
  } catch (err) {
    console.error("[/api/video/start] Unhandled exception:", err);
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      upstreamStatus: 500,
      error: `Interactions API HTTP 500: ${err.message || "Network error"}`
    });
  }
}
