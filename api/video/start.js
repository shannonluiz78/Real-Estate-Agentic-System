/**
 * AgentZug V4.7 — api/video/start.js
 * Google Gemini Interactions API Video Starter for gemini-omni-1.2-flash
 *
 * - Uploads reference portrait via Gemini Files API (https://generativelanguage.googleapis.com/upload/v1beta/files)
 *   and passes { type: "image", uri, mime_type } alongside the natural-language prompt & spoken dialogue
 *   (matching Google's official gemini-omni-flash-api reference-to-video pipeline).
 * - Falls back to inline base64 image data if Files API upload is unavailable.
 */

const CREDIT_LIMIT_SGD = parseFloat(process.env.MONTHLY_CLOUD_CREDIT_LIMIT_SGD || "12.83");
const BACKUP_TRIGGER_SGD = parseFloat(process.env.MANUAL_BACKUP_TRIGGER_SGD || "11.50");
const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";
const INTERACTIONS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const FILES_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files";

function estimateSceneCostSgd(durationSec = 10, mode = "AVATAR_REF") {
  const dur = Math.min(15, Math.max(3, Number(durationSec) || 10));
  const ratePerSec = mode === "AVATAR_REF" ? 0.035 : 0.025;
  return Number((dur * ratePerSec).toFixed(2));
}

function appendApiKeyIfNeeded(rawUri, geminiKey) {
  if (!rawUri) return rawUri;
  if (rawUri.includes("generativelanguage.googleapis.com") && !rawUri.includes("key=")) {
    const sep = rawUri.includes("?") ? "&" : "?";
    return `${rawUri}${sep}key=${encodeURIComponent(geminiKey)}`;
  }
  return rawUri;
}

async function uploadReferenceImageToGeminiFilesApi({ geminiKey, base64Data, mimeType }) {
  try {
    const binaryBuffer = Buffer.from(base64Data, "base64");
    const uploadResp = await fetch(`${FILES_UPLOAD_URL}?key=${encodeURIComponent(geminiKey)}`, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "raw",
        "X-Goog-Upload-Command": "upload, finalize",
        "X-Goog-Upload-Header-Content-Length": String(binaryBuffer.length),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": mimeType
      },
      body: binaryBuffer
    });

    if (!uploadResp.ok) {
      const errTxt = await uploadResp.text().catch(() => "");
      console.warn("[/api/video/start] Files API raw upload non-OK:", uploadResp.status, errTxt.slice(0, 160));
      return null;
    }

    const fileJson = await uploadResp.json();
    const fileObj = fileJson?.file || fileJson;
    const fileUri = fileObj?.uri || null;
    const fileName = fileObj?.name || null;

    // Poll briefly if file state is PROCESSING
    if (fileName && fileObj?.state === "PROCESSING") {
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 800));
        const checkResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(geminiKey)}`);
        if (checkResp.ok) {
          const checkJson = await checkResp.json();
          if (checkJson?.state === "ACTIVE") {
            return { uri: checkJson.uri || fileUri, mimeType: checkJson.mimeType || mimeType };
          }
        }
      }
    }

    if (fileUri) {
      return { uri: fileUri, mimeType: fileObj?.mimeType || mimeType };
    }
  } catch (err) {
    console.warn("[/api/video/start] Files API upload exception:", err.message);
  }
  return null;
}

function extractVideoFromInteraction(interaction, geminiKey) {
  const candidateCollections = [];

  if (Array.isArray(interaction?.steps)) {
    for (const step of interaction.steps) {
      if (step && typeof step === "object") {
        candidateCollections.push(step);
        if (Array.isArray(step.content)) candidateCollections.push(...step.content);
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

  for (const item of candidateCollections) {
    if (!item || typeof item !== "object") continue;
    const itemType = String(item?.type || "").toLowerCase();
    const mimeType = String(item?.mime_type || item?.mimeType || "");
    if (itemType === "video" || mimeType.toLowerCase().startsWith("video/")) {
      if (typeof item?.data === "string" && item.data.length > 0) {
        return { videoDataUri: `data:${mimeType || "video/mp4"};base64,${item.data}`, videoUrl: null };
      }
      const rawUri = item?.uri || item?.url || item?.file_uri || item?.fileUri;
      if (typeof rawUri === "string" && rawUri.length > 0) {
        return { videoUrl: appendApiKeyIfNeeded(rawUri, geminiKey), videoDataUri: null };
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
    const clampedDur = Math.min(15, Math.max(3, Math.round(Number(durationSec) || 10)));
    const durationTag = `${clampedDur}s`;
    const aspectRatio = "9:16";
    const cleanDialogue = String(spokenScript || "").trim();

    // Strip legacy meta-prefix if present so prompt uses natural language
    const cleanedScenePrompt = String(prompt || "")
      .replace(/^Advisor Avatar Reference\s*\([^)]*\)\s*/i, "")
      .trim();

    const hasAvatarImage =
      mode === "AVATAR_REF" &&
      typeof advisorAvatarDataUri === "string" &&
      advisorAvatarDataUri.startsWith("data:image/");

    // Consistent identity-anchored reference-to-video prompt so Clip 1 and Clip 3 match identically
    const sceneLead = hasAvatarImage
      ? `In a single continuous ${durationTag} unbroken vertical shot, the exact same Singaporean Chinese male real estate advisor from the attached reference photo (identical facial structure, hairstyle, skin tone, and smart navy blazer over a crisp white shirt) ${cleanedScenePrompt || "speaks warmly and confidently directly to the camera in a sunlit modern Singapore showflat lounge, medium close-up portrait framing, subtle natural hand gestures."}`
      : mode === "AVATAR_REF"
        ? `In a single continuous ${durationTag} unbroken vertical shot, a 45-year-old Singaporean Chinese male real estate advisor in a smart navy blazer over a crisp white shirt ${cleanedScenePrompt || "speaks warmly and confidently directly to the camera in a sunlit modern Singapore showflat lounge, medium close-up portrait framing, subtle natural hand gestures."}`
        : `In a single continuous ${durationTag} unbroken vertical shot, ${cleanedScenePrompt}`;

    const audioDirective = cleanDialogue
      ? mode === "AVATAR_REF"
        ? `The advisor speaks directly on camera in a warm, natural Singaporean English baritone voice with synchronized lip movement saying: "${cleanDialogue}" Clean studio room tone only, no background music, no text overlays, no subtitles, no watermarks.`
        : `Off-screen narration in a warm Singaporean English male baritone voice says: "${cleanDialogue}" Subtle architectural ambient room tone only, no background music, no text overlays, no subtitles, no watermarks.`
      : "Subtle clean ambient room tone only, no background music, no text overlays, no subtitles, no watermarks.";

    const fullPrompt = `${sceneLead} ${audioDirective}`;

    // Place text instruction before single reference image per Google Interactions API best practices
    const inputContent = [{ type: "text", text: fullPrompt }];
    let attachedImageMethod = "none";

    if (hasAvatarImage && advisorAvatarDataUri) {
      const match = advisorAvatarDataUri.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const base64Data = match[2];

        // Upload via Gemini Files API first (recommended for Interactions API R2V)
        const uploadedFile = await uploadReferenceImageToGeminiFilesApi({
          geminiKey,
          base64Data,
          mimeType
        });

        if (uploadedFile && uploadedFile.uri) {
          inputContent.push({
            type: "image",
            uri: uploadedFile.uri,
            mime_type: uploadedFile.mimeType
          });
          attachedImageMethod = "files-api-uri";
        } else {
          inputContent.push({
            type: "image",
            data: base64Data,
            mime_type: mimeType
          });
          attachedImageMethod = "inline-base64";
        }
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
        response_format: {
          type: "video",
          aspect_ratio: aspectRatio,
          duration: durationTag,
          resolution: "720p",
          delivery: "uri"
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
        attachedImageMethod,
        status: resp.status,
        body: parsed
      });
      const detail = parsed?.error?.message || rawText.slice(0, 240) || resp.statusText;
      return res.status(200).json({
        ok: false,
        status: "FAILED",
        upstreamStatus: resp.status,
        upstreamBody: parsed,
        attachedImageMethod,
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

    const media = extractVideoFromInteraction(parsed, geminiKey);
    if (interactionStatus === "completed" && (media.videoDataUri || media.videoUrl)) {
      return res.status(200).json({
        ok: true,
        status: "DONE",
        interactionId,
        operationId: interactionId,
        interactionStatus,
        attachedImageMethod,
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

    return res.status(200).json({
      ok: true,
      status: "RUNNING",
      interactionId,
      operationId: interactionId,
      interactionStatus,
      attachedImageMethod,
      initialVideoUrl: media.videoUrl || null,
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
