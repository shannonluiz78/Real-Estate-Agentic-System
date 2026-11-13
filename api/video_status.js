/**
 * AgentZug V4.7 — /api/video/status
 * Async Video Operation Poller (Vercel & Google Cloud Run)
 *
 * Polls Google Gemini operation status using GEMINI_API_KEY and returns
 * { ok: true, status: "RUNNING" | "DONE" | "FAILED", videoUrl, videoDataUri, previewImageDataUri }
 */

const NANO_BANANA_2_LITE = process.env.MODEL_IMAGE_GEN || "gemini-3.1-flash-lite-image";

async function generateFallbackVisualFrame({ geminiKey, prompt }) {
  if (!geminiKey) return null;
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(NANO_BANANA_2_LITE)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] }
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
    if (!part) return null;
    return `data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}`;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const params = req.method === "POST" ? (req.body || {}) : (req.query || {});
  const operationId = String(params.operationId || "").trim();
  const geminiKey = process.env.GEMINI_API_KEY || "";

  if (!operationId) {
    return res.status(400).json({ ok: false, error: "operationId is required" });
  }

  // Handle local / fallback operation IDs immediately
  if (operationId.startsWith("fallback-") || operationId.startsWith("local-") || operationId.startsWith("err-")) {
    return res.status(200).json({
      ok: true,
      status: "DONE",
      source: "curated-fallback",
      videoDataUri: null,
      previewImageDataUri: null
    });
  }

  // Handle hybrid async operations (synthesizes a fresh 9:16 Nano Banana 2 Lite scene frame for motion canvas)
  if (operationId.startsWith("hybrid.")) {
    let meta = { prompt: "Singapore luxury condominium living room at golden hour", mode: "BROLL" };
    try {
      const b64 = operationId.slice("hybrid.".length);
      meta = JSON.parse(Buffer.from(b64, "base64url").toString("utf-8"));
    } catch (e) {}

    const scenePrompt = `Create a vertical 9:16 Singapore real estate architectural photograph: ${meta.prompt}. Clean dark negative space at top third and bottom quarter. Strictly no text, no letters, no numbers, no watermarks, no logos, no people.`;
    const imgUri = await generateFallbackVisualFrame({ geminiKey, prompt: scenePrompt });

    return res.status(200).json({
      ok: true,
      status: "DONE",
      source: imgUri ? "omni-1.2-flash-hybrid" : "curated-fallback",
      videoDataUri: null,
      previewImageDataUri: imgUri
    });
  }

  // Poll live Google Gemini Long-Running Operation
  if (!geminiKey) {
    return res.status(200).json({
      ok: true,
      status: "DONE",
      source: "curated-fallback"
    });
  }

  try {
    const cleanOpPath = operationId.startsWith("operations/") || operationId.startsWith("models/")
      ? operationId
      : `operations/${operationId}`;
    const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${cleanOpPath}?key=${encodeURIComponent(geminiKey)}`;

    const resp = await fetch(pollUrl, { method: "GET" });
    if (!resp.ok) {
      return res.status(200).json({
        ok: true,
        status: "DONE",
        source: "curated-fallback",
        note: `Poll HTTP ${resp.status}`
      });
    }

    const opData = await resp.json();
    if (!opData.done) {
      return res.status(200).json({
        ok: true,
        status: "RUNNING",
        source: "gemini-omni-1.2-flash",
        metadata: opData.metadata || null
      });
    }

    // Operation completed — extract generated video URI or base64 payload
    const generatedSamples =
      opData?.response?.generateVideoResponse?.generatedSamples ||
      opData?.response?.predictions ||
      [];
    const firstSample = generatedSamples[0] || {};
    const rawVideoUri = firstSample?.video?.uri || firstSample?.uri || null;
    const base64Video = firstSample?.bytesBase64Encoded || firstSample?.video?.bytesBase64Encoded || null;

    let videoDataUri = null;
    if (base64Video) {
      videoDataUri = `data:video/mp4;base64,${base64Video}`;
    } else if (rawVideoUri) {
      // Append API key if it's a Google Generative Language file URI so browser <video> can stream it
      const sep = rawVideoUri.includes("?") ? "&" : "?";
      const fetchableUrl = rawVideoUri.includes("generativelanguage.googleapis.com")
        ? `${rawVideoUri}${sep}key=${encodeURIComponent(geminiKey)}`
        : rawVideoUri;
      return res.status(200).json({
        ok: true,
        status: "DONE",
        source: "gemini-omni-1.2-flash",
        videoUrl: fetchableUrl
      });
    }

    return res.status(200).json({
      ok: true,
      status: "DONE",
      source: videoDataUri ? "gemini-omni-1.2-flash" : "curated-fallback",
      videoDataUri
    });
  } catch (err) {
    return res.status(200).json({
      ok: true,
      status: "DONE",
      source: "curated-fallback",
      error: err.message
    });
  }
}
