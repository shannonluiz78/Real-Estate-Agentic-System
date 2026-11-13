/**
 * AgentZug V4.7 — /api/video/status
 * Async Video Operation Poller for gemini-omni-1.2-flash (Vercel & Google Cloud Run)
 */

const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const params = req.method === "POST" ? (req.body || {}) : (req.query || {});
  const operationId = String(params.operationId || "").trim();
  const geminiKey = process.env.GEMINI_API_KEY || "";

  if (!operationId) {
    return res.status(400).json({ ok: false, status: "FAILED", error: "operationId is required" });
  }

  if (!geminiKey) {
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      httpStatus: 401,
      error: "HTTP 401: GEMINI_API_KEY missing in Vercel .env"
    });
  }

  try {
    const cleanOpPath = operationId.startsWith("operations/") || operationId.startsWith("models/")
      ? operationId
      : `operations/${operationId}`;
    const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${cleanOpPath}?key=${encodeURIComponent(geminiKey)}`;

    const resp = await fetch(pollUrl, { method: "GET" });
    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try {
        const errJson = await resp.json();
        errMsg = `HTTP ${resp.status}: ${(errJson?.error?.message || resp.statusText).slice(0, 180)}`;
      } catch (e) {}
      return res.status(200).json({
        ok: false,
        status: "FAILED",
        httpStatus: resp.status,
        error: errMsg
      });
    }

    const opData = await resp.json();
    if (opData.error) {
      return res.status(200).json({
        ok: false,
        status: "FAILED",
        httpStatus: opData.error.code || 500,
        error: `HTTP ${opData.error.code || 500}: ${(opData.error.message || "Operation failed").slice(0, 180)}`
      });
    }

    if (!opData.done) {
      return res.status(200).json({
        ok: true,
        status: "RUNNING",
        source: OMNI_VIDEO_MODEL,
        metadata: opData.metadata || null
      });
    }

    const generatedSamples =
      opData?.response?.generateVideoResponse?.generatedSamples ||
      opData?.response?.predictions ||
      [];
    const firstSample = generatedSamples[0] || {};
    const rawVideoUri = firstSample?.video?.uri || firstSample?.uri || null;
    const base64Video = firstSample?.bytesBase64Encoded || firstSample?.video?.bytesBase64Encoded || null;

    if (base64Video) {
      return res.status(200).json({
        ok: true,
        status: "DONE",
        source: OMNI_VIDEO_MODEL,
        videoDataUri: `data:video/mp4;base64,${base64Video}`
      });
    }

    if (rawVideoUri) {
      const sep = rawVideoUri.includes("?") ? "&" : "?";
      const fetchableUrl = rawVideoUri.includes("generativelanguage.googleapis.com")
        ? `${rawVideoUri}${sep}key=${encodeURIComponent(geminiKey)}`
        : rawVideoUri;
      return res.status(200).json({
        ok: true,
        status: "DONE",
        source: OMNI_VIDEO_MODEL,
        videoUrl: fetchableUrl
      });
    }

    return res.status(200).json({
      ok: false,
      status: "FAILED",
      httpStatus: 204,
      error: "HTTP 204: Operation completed without video output sample"
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      status: "FAILED",
      httpStatus: 500,
      error: `HTTP 500: ${err.message || "Polling error"}`
    });
  }
}
