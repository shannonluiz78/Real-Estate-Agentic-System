/**
 * AgentZug V4.7 — api/video/status.js
 * Google Gemini Interactions API Poller for gemini-omni-1.2-flash
 */

const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";
const INTERACTIONS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

function appendApiKeyIfNeeded(rawUri, geminiKey) {
  if (!rawUri) return rawUri;
  if (rawUri.includes("generativelanguage.googleapis.com") && !rawUri.includes("key=")) {
    const sep = rawUri.includes("?") ? "&" : "?";
    return `${rawUri}${sep}key=${encodeURIComponent(geminiKey)}`;
  }
  return rawUri;
}

function extractFailureDetails(interaction) {
  const details = [];
  if (interaction?.error?.message) details.push(String(interaction.error.message));
  if (interaction?.status_message) details.push(String(interaction.status_message));
  if (interaction?.failure_reason) details.push(String(interaction.failure_reason));

  if (Array.isArray(interaction?.steps)) {
    for (const step of interaction.steps) {
      if (!step || typeof step !== "object") continue;
      if (step.error?.message) details.push(String(step.error.message));
      if (step.message) details.push(String(step.message));
      if (Array.isArray(step.content)) {
        for (const part of step.content) {
          if (part?.text) details.push(String(part.text));
          if (part?.error?.message) details.push(String(part.error.message));
        }
      }
    }
  }
  const unique = [...new Set(details.map(s => s.trim()).filter(Boolean))];
  return unique.join(" | ").slice(0, 260);
}

function extractVideoFromInteraction(interaction, geminiKey) {
  const candidateCollections = [];
  const textNotes = [];

  if (Array.isArray(interaction?.steps)) {
    for (const step of interaction.steps) {
      if (step && typeof step === "object") {
        const stepType = String(step.type || "").toLowerCase();
        candidateCollections.push(step);
        if (Array.isArray(step.content)) {
          for (const part of step.content) {
            if (part && typeof part === "object") {
              candidateCollections.push(part);
              if (stepType === "model_output" && part.type === "text" && typeof part.text === "string") {
                textNotes.push(part.text);
              }
            }
          }
        }
        if (Array.isArray(step.parts)) candidateCollections.push(...step.parts);
      }
    }
  }

  if (Array.isArray(interaction?.outputs)) {
    for (const out of interaction.outputs) {
      if (out && typeof out === "object") {
        candidateCollections.push(out);
        if (Array.isArray(out.content)) candidateCollections.push(...out.content);
        if (Array.isArray(out.parts)) candidateCollections.push(...out.parts);
      }
    }
  }

  for (const key of ["output", "result"]) {
    const obj = interaction?.[key];
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      candidateCollections.push(obj);
    }
  }

  for (const item of candidateCollections) {
    if (!item || typeof item !== "object") continue;
    const itemType = String(item?.type || "").toLowerCase();
    const mimeType = String(item?.mime_type || item?.mimeType || "");
    if (itemType === "video" || mimeType.toLowerCase().startsWith("video/")) {
      if (typeof item?.data === "string" && item.data.length > 0) {
        return { videoDataUri: `data:${mimeType || "video/mp4"};base64,${item.data}`, videoUrl: null, modelTextNote: textNotes.join(" ").trim() };
      }
      const rawUri = item?.uri || item?.url || item?.file_uri || item?.fileUri;
      if (typeof rawUri === "string" && rawUri.length > 0) {
        return { videoUrl: appendApiKeyIfNeeded(rawUri, geminiKey), videoDataUri: null, modelTextNote: textNotes.join(" ").trim() };
      }
    }
  }

  return { videoUrl: null, videoDataUri: null, modelTextNote: textNotes.join(" ").trim() };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const params = req.method === "POST" ? (req.body || {}) : (req.query || {});
  const interactionId = String(params.interactionId || params.operationId || "").trim();
  const initialVideoUrl = String(params.initialVideoUrl || "").trim();
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
      console.error("[/api/video/status] Interaction failed payload:", JSON.stringify(data).slice(0, 800));
      const code = Number(data?.error?.code || 500);
      const extractedDetail = extractFailureDetails(data);
      const msg = extractedDetail || `Interaction ${iStatus || "failed"}`;
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
    const resolvedUrl = media.videoUrl || (initialVideoUrl ? appendApiKeyIfNeeded(initialVideoUrl, geminiKey) : null);

    if (media.videoDataUri || resolvedUrl) {
      return res.status(200).json({
        ok: true,
        status: "DONE",
        interactionId: cleanId,
        interactionStatus: "completed",
        source: OMNI_VIDEO_MODEL,
        videoUrl: resolvedUrl,
        videoDataUri: media.videoDataUri
      });
    }

    const noteSuffix = media.modelTextNote ? `: ${media.modelTextNote.slice(0, 180)}` : "";
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      upstreamStatus: 204,
      upstreamBody: data,
      error: `Interactions API HTTP 204: Interaction completed without a playable video output step${noteSuffix}`
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
