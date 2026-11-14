/**
 * AgentZug V4.7 — app/api/video/start/route.ts
 * Next.js App Router Route Handler for /api/video/start
 *
 * Calls Google Gemini API (`generativelanguage.googleapis.com/v1beta/models/gemini-omni-1.2-flash:generateContent`,
 * with automatic fallback to `:predictLongRunning` / `:interactions` if required by model capabilities).
 * Logs and forwards exact upstream Gemini API status and response body on any rejection.
 */

import { NextRequest, NextResponse } from "next/server";

const CREDIT_LIMIT_SGD = parseFloat(process.env.MONTHLY_CLOUD_CREDIT_LIMIT_SGD || "12.83");
const BACKUP_TRIGGER_SGD = parseFloat(process.env.MANUAL_BACKUP_TRIGGER_SGD || "11.50");
const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";

function estimateSceneCostSgd(durationSec = 10, mode = "AVATAR_REF"): number {
  const dur = Math.min(15, Math.max(8, Number(durationSec) || 10));
  const ratePerSec = mode === "AVATAR_REF" ? 0.035 : 0.025;
  return Number((dur * ratePerSec).toFixed(2));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      sceneIndex = 0,
      sceneTitle = "Scene 1: Hook",
      prompt = "",
      spokenScript = "",
      durationSec = 10,
      mode = "AVATAR_REF", // "AVATAR_REF" | "BROLL"
      advisorAvatarDataUri = null,
      currentSpendSgd = 3.42
    } = body;

    const spend = Number(currentSpendSgd || 0);
    const estCost = estimateSceneCostSgd(durationSec, mode);

    // SP-12 Credit Cap Guardrail
    if (spend >= CREDIT_LIMIT_SGD || spend + estCost > CREDIT_LIMIT_SGD) {
      return NextResponse.json(
        {
          ok: false,
          status: "FAILED",
          upstreamStatus: 402,
          error: `SP-12 Credit Cap (S$${CREDIT_LIMIT_SGD.toFixed(2)}/mo) reached — use Manual Backup Flow`,
          model: OMNI_VIDEO_MODEL,
          triggerManualBackupDrawer: true
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    const geminiKey = process.env.GEMINI_API_KEY || "";
    if (!geminiKey) {
      console.error("[/api/video/start] Missing GEMINI_API_KEY in server environment");
      return NextResponse.json(
        {
          ok: false,
          status: "FAILED",
          upstreamStatus: 401,
          error: "Upstream Gemini HTTP 401: GEMINI_API_KEY is missing in Vercel environment variables",
          model: OMNI_VIDEO_MODEL
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    const clampedDur = Math.min(15, Math.max(8, Number(durationSec) || 10));
    const fullPrompt = spokenScript
      ? `${prompt}\nSpoken Dialogue (45yo Singaporean Chinese male English advisor, warm baritone, ${clampedDur}s): "${spokenScript}"\nTarget aspect ratio: 9:16 vertical. Strictly no burned-in text, no captions, no watermarks, no logos.`
      : `${prompt}\nTarget aspect ratio: 9:16 vertical, duration ${clampedDur}s. Strictly no burned-in text, no captions, no watermarks, no logos.`;

    // Build multimodal parts (text + optional advisor headshot inlineData reference)
    const parts: Array<Record<string, unknown>> = [{ text: fullPrompt }];
    let inlineImageObj: { mimeType: string; data: string } | null = null;

    if (mode === "AVATAR_REF" && typeof advisorAvatarDataUri === "string" && advisorAvatarDataUri.startsWith("data:image/")) {
      const match = advisorAvatarDataUri.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        inlineImageObj = { mimeType: match[1], data: match[2] };
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2]
          }
        });
      }
    }

    // Primary Attempt: Official Gemini v1beta :generateContent endpoint supported by GEMINI_API_KEY
    const generateContentUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(OMNI_VIDEO_MODEL)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
    const gcPayload = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.4
      }
    };

    const gcResp = await fetch(generateContentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gcPayload)
    });

    const gcRawText = await gcResp.text();
    let gcParsed: Record<string, unknown> = {};
    try {
      gcParsed = JSON.parse(gcRawText);
    } catch {
      gcParsed = { rawBody: gcRawText };
    }

    if (gcResp.ok) {
      // Check if :generateContent returned an inline video/media part or fileData URI synchronously
      const candidates = Array.isArray(gcParsed?.candidates) ? gcParsed.candidates : [];
      const respParts = candidates[0]?.content?.parts || [];
      const mediaPart = respParts.find(
        (p: Record<string, unknown>) =>
          (p.inlineData && typeof (p.inlineData as Record<string, unknown>).data === "string") ||
          (p.fileData && typeof (p.fileData as Record<string, unknown>).fileUri === "string")
      );

      if (mediaPart?.inlineData) {
        const mimeType = mediaPart.inlineData.mimeType || "video/mp4";
        return NextResponse.json(
          {
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
            triggerManualBackupDrawer: spend + estCost >= BACKUP_TRIGGER_SGD
          },
          { status: 200, headers: corsHeaders() }
        );
      }

      if (mediaPart?.fileData?.fileUri) {
        const rawUri = String(mediaPart.fileData.fileUri);
        const sep = rawUri.includes("?") ? "&" : "?";
        const fetchableUrl = rawUri.includes("generativelanguage.googleapis.com")
          ? `${rawUri}${sep}key=${encodeURIComponent(geminiKey)}`
          : rawUri;
        return NextResponse.json(
          {
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
            triggerManualBackupDrawer: spend + estCost >= BACKUP_TRIGGER_SGD
          },
          { status: 200, headers: corsHeaders() }
        );
      }

      // If :generateContent returned an async operation name
      if (typeof gcParsed?.name === "string" && gcParsed.name) {
        return NextResponse.json(
          {
            ok: true,
            status: "RUNNING",
            source: OMNI_VIDEO_MODEL,
            endpointUsed: "generateContent",
            operationId: gcParsed.name,
            model: OMNI_VIDEO_MODEL,
            sceneIndex,
            estimatedCostSgd: estCost,
            triggerManualBackupDrawer: spend + estCost >= BACKUP_TRIGGER_SGD
          },
          { status: 200, headers: corsHeaders() }
        );
      }
    }

    // Log exact upstream response from :generateContent
    console.error("[/api/video/start] Upstream :generateContent response:", {
      model: OMNI_VIDEO_MODEL,
      status: gcResp.status,
      body: gcParsed
    });

    // Secondary Attempt: Try :predictLongRunning if :generateContent indicated method unsupported (HTTP 400/404)
    const gcErrDetail = (gcParsed?.error as Record<string, unknown>)?.message
      ? String((gcParsed.error as Record<string, unknown>).message)
      : gcRawText.slice(0, 240);

    if (gcResp.status === 400 || gcResp.status === 404) {
      const plrUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(OMNI_VIDEO_MODEL)}:predictLongRunning?key=${encodeURIComponent(geminiKey)}`;
      const instancePayload: Record<string, unknown> = { prompt: fullPrompt };
      if (inlineImageObj) {
        instancePayload.image = {
          inlineData: inlineImageObj
        };
      }

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
      let plrParsed: Record<string, unknown> = {};
      try {
        plrParsed = JSON.parse(plrRawText);
      } catch {
        plrParsed = { rawBody: plrRawText };
      }

      if (plrResp.ok && typeof plrParsed?.name === "string") {
        return NextResponse.json(
          {
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
            triggerManualBackupDrawer: spend + estCost >= BACKUP_TRIGGER_SGD
          },
          { status: 200, headers: corsHeaders() }
        );
      }

      console.error("[/api/video/start] Upstream :predictLongRunning rejected:", {
        model: OMNI_VIDEO_MODEL,
        status: plrResp.status,
        body: plrParsed
      });

      const plrErrDetail = (plrParsed?.error as Record<string, unknown>)?.message
        ? String((plrParsed.error as Record<string, unknown>).message)
        : plrRawText.slice(0, 240);

      // Forward exact upstream Gemini API status and response body to client
      return NextResponse.json(
        {
          ok: false,
          status: "FAILED",
          upstreamStatus: gcResp.status,
          upstreamEndpoint: `models/${OMNI_VIDEO_MODEL}:generateContent`,
          upstreamBody: gcParsed,
          fallbackAttemptStatus: plrResp.status,
          fallbackAttemptBody: plrParsed,
          error: `Upstream Gemini HTTP ${gcResp.status} (${OMNI_VIDEO_MODEL}): ${gcErrDetail || plrErrDetail}`
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    // Forward exact upstream status & response body for 401/403/429/500 errors
    return NextResponse.json(
      {
        ok: false,
        status: "FAILED",
        upstreamStatus: gcResp.status,
        upstreamEndpoint: `models/${OMNI_VIDEO_MODEL}:generateContent`,
        upstreamBody: gcParsed,
        error: `Upstream Gemini HTTP ${gcResp.status} (${OMNI_VIDEO_MODEL}): ${gcErrDetail}`
      },
      { status: 200, headers: corsHeaders() }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error in /api/video/start";
    console.error("[/api/video/start] Unhandled exception:", err);
    return NextResponse.json(
      {
        ok: false,
        status: "FAILED",
        upstreamStatus: 500,
        error: `Upstream Gemini HTTP 500: ${message}`
      },
      { status: 200, headers: corsHeaders() }
    );
  }
}
