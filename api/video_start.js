/**
 * AgentZug V4.7 — /api/video/start
 * Async Video Clip Generation Starter for Vercel & Google Cloud Run
 *
 * Uses GEMINI_API_KEY and gemini-omni-1.2-flash (:predictLongRunning / generateContent)
 * so each 8s-15s storyboard scene can be generated asynchronously without hitting
 * Vercel serverless function timeouts.
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
    durationSec = 10,
    mode = "AVATAR_REF", // "AVATAR_REF" | "BROLL"
    advisorAvatarDataUri = null,
    topic = "",
    currentSpendSgd = 3.42
  } = req.body || {};

  const spend = Number(currentSpendSgd || 0);
  const estCost = estimateSceneCostSgd(durationSec, mode);

  // SP-12 Credit Cap Guardrail
  if (spend >= CREDIT_LIMIT_SGD || (spend + estCost) > CREDIT_LIMIT_SGD) {
    return res.status(200).json({
      ok: true,
      status: "FALLBACK_READY",
      source: "curated-fallback",
      operationId: `fallback-${Date.now()}-${sceneIndex}`,
      model: OMNI_VIDEO_MODEL,
      estimatedCostSgd: 0,
      fallbackReason: `SP-12 credit cap (S$${CREDIT_LIMIT_SGD.toFixed(2)}/mo) reached — using In-App Canvas + Nano Banana 2 Lite scene`,
      triggerManualBackupDrawer: true
    });
  }

  const geminiKey = process.env.GEMINI_API_KEY || "";
  if (!geminiKey) {
    return res.status(200).json({
      ok: true,
      status: "FALLBACK_READY",
      source: "curated-fallback",
      operationId: `local-${Date.now()}-${sceneIndex}`,
      model: OMNI_VIDEO_MODEL,
      estimatedCostSgd: 0,
      fallbackReason: "GEMINI_API_KEY not configured on server — using In-App 60fps Canvas Compositor"
    });
  }

  try {
    // Call Gemini API predictLongRunning for gemini-omni-1.2-flash
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(OMNI_VIDEO_MODEL)}:predictLongRunning?key=${encodeURIComponent(geminiKey)}`;

    const instancePayload = {
      prompt: `${prompt} Strictly no burned-in text, no captions, no watermarks, no logos.`
    };

    if (mode === "AVATAR_REF" && advisorAvatarDataUri && advisorAvatarDataUri.startsWith("data:image/")) {
      const match = advisorAvatarDataUri.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        instancePayload.image = {
          bytesBase64Encoded: match[2],
          mimeType: match[1]
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

    if (resp.ok) {
      const opData = await resp.json();
      if (opData && opData.name) {
        return res.status(200).json({
          ok: true,
          status: "RUNNING",
          source: "gemini-omni-1.2-flash",
          operationId: opData.name,
          model: OMNI_VIDEO_MODEL,
          sceneIndex,
          sceneTitle,
          mode,
          durationSec,
          estimatedCostSgd: estCost,
          triggerManualBackupDrawer: (spend + estCost) >= BACKUP_TRIGGER_SGD
        });
      }
    }

    const errText = await resp.text().catch(() => "");
    // Graceful async fallback token so /api/video/status can synthesize a topic-matched Nano Banana 2 Lite visual if predictLongRunning isn't enabled on the key
    const encodedMeta = Buffer.from(JSON.stringify({
      sceneIndex,
      mode,
      topic: topic || sceneTitle,
      prompt: prompt.slice(0, 320)
    })).toString("base64url");

    return res.status(200).json({
      ok: true,
      status: "RUNNING",
      source: "omni-hybrid-async",
      operationId: `hybrid.${encodedMeta}`,
      model: OMNI_VIDEO_MODEL,
      sceneIndex,
      estimatedCostSgd: 0.02,
      apiNote: `HTTP ${resp.status}: ${errText.slice(0, 120)}`
    });
  } catch (err) {
    return res.status(200).json({
      ok: true,
      status: "FALLBACK_READY",
      source: "curated-fallback",
      operationId: `err-${Date.now()}-${sceneIndex}`,
      model: OMNI_VIDEO_MODEL,
      estimatedCostSgd: 0,
      fallbackReason: err.message || "Network error starting async video generation"
    });
  }
}
