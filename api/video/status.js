/**
 * AgentZug V4.7 — api/video/status.js
 * Google Gemini Interactions API Poller for gemini-omni-1.2-flash
 */

const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";
const INTERACTIONS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

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
    const nestedParts = Array.isArray(item?.content) ? item.content : (Array.isArray(item?.parts) ? item.parts : []);
    for (const part of nestedParts) {
      const pMime = String(part?.mime_type || part?.mimeType || "");
      if (part?.type === "video" || pMime.startsWith("video/")) {
        if (typeof part?.data === "string" && part.data) {
          return { videoDataUri: `data:${pMime || "video/mp4"};base64,${part.data}`, videoUrl: null };
        }
        const pUri = part?.uri || part?.url || part?.file_uri;
        if (pUri) {
          const sep = pUri.includes("?") ? "&" : "?";
          const videoUrl = pUri.includes("generativelanguage.googleapis.com")
            ? `${pUri}${sep}key=${encodeURIComponent(geminiKey)}`
            : pUri;
          return { videoUrl, videoDataUri: null };
        }
      }
    }
  }
  const singleOutput = interaction?.output || interaction?.result;
  if (singleOutput && typeof singleOutput === "object") {
    const sMime = String(singleOutput?.mime_type || singleOutput?.mimeType || "video/mp4");
    if (typeof singleOutput?.data === "string" && singleOutput.data) {
      return { videoDataUri: `data:${sMime};base64,${singleOutput.data}`, videoUrl: null };
    }
    const sUri = singleOutput?.uri || singleOutput?.url || singleOutput?.file_uri;
    if (sUri) {
      const sep = sUri.includes("?") ? "&" : "?";
      const videoUrl = sUri.includes("generativelanguage.googleapis.com")
        ? `${sUri}${sep}key=${encodeURIComponent(geminiKey)}`
        : sUri;
      return { videoUrl, videoDataUri: null };
    }
  }
  return { videoUrl: null, videoDataUri: null };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const params = req.method === "POST" ? (req.body || {}) : (req.query || {});
  const interactionId = String(params.interactionId || params.operationId || "").trim();
  const geminiKey = process.env.GEMINI_API_KEY || "";

  if (!interactionId) {
    return res.status(400).json({ ok: false, status: "FAILED", upstreamStatus: 400, error: "interactionId is required" });
  }

  if (!geminiKey) {
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      upstreamStatus: 401,
      error: "Interactions API HTTP 401: GEMINI_API_KEY missing in Vercel .env"
    });
  }

  try {
    const cleanId = interactionId.replace(/^interactions\//, "");
    const pollUrl = `${INTERACTIONS_BASE_URL}/${encodeURIComponent(cleanId)}`;

    const resp = await fetch(pollUrl, {
      method: "GET",
      headers: {
        "x-goog-api-key": geminiKey
      }
    });

    const rawText = await resp.text();
    let data = {};
    try { data = JSON.parse(rawText); } catch (e) { data = { rawBody: rawText }; }

    if (!resp.ok) {
      console.error("[/api/video/status] Gemini Interactions poll error:", {
        interactionId: cleanId,
        status: resp.status,
        body: data
      });
      const errDetail = data?.error?.message || rawText.slice(0, 220) || resp.statusText;
      return res.status(200).json({
        ok: false,
        status: "FAILED",
        upstreamStatus: resp.status,
        upstreamBody: data,
        error: `Interactions Poll HTTP ${resp.status}: ${errDetail}`
      });
    }

    const iStatus = String(data?.status || "").toLowerCase();

    if (iStatus === "failed" || iStatus === "cancelled" || data?.error) {
      const code = Number(data?.error?.code || 500);
      const msg = String(data?.error?.message || data?.status_message || `Interaction ${iStatus || "failed"}`).slice(0, 220);
      return res.status(200).json({
        ok: false,
        status: "FAILED",
        upstreamStatus: code,
        upstreamBody: data,
        error: `Interactions API HTTP ${code}: ${msg}`
      });
    }

    if (iStatus !== "completed" && data?.done !== true) {
      return res.status(200).json({
        ok: true,
        status: "RUNNING",
        interactionId: cleanId,
        interactionStatus: iStatus || "in_progress",
        source: OMNI_VIDEO_MODEL
      });
    }

    const media = extractVideoFromInteraction(data, geminiKey);
    if (media.videoDataUri || media.videoUrl) {
      return res.status(200).json({
        ok: true,
        status: "DONE",
        interactionId: cleanId,
        interactionStatus: "completed",
        source: OMNI_VIDEO_MODEL,
        videoUrl: media.videoUrl,
        videoDataUri: media.videoDataUri
      });
    }

    return res.status(200).json({
      ok: false,
      status: "FAILED",
      upstreamStatus: 204,
      upstreamBody: data,
      error: "Interactions API HTTP 204: Interaction completed without a playable video output step"
    });
  } catch (err) {
    console.error("[/api/video/status] Unhandled exception:", err);
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      upstreamStatus: 500,
      error: `Interactions Poll HTTP 500: ${err.message || "Polling error"}`
    });
  }
}
