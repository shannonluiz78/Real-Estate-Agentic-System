/**
 * AgentZug V4.7 — app/api/video/start/route.ts
 * Google Gemini Interactions API Video Starter for gemini-omni-1.2-flash
 *
 * Calls POST https://generativelanguage.googleapis.com/v1beta/interactions
 * with header `x-goog-api-key: GEMINI_API_KEY`, `model: "gemini-omni-1.2-flash"`,
 * `background: true`, `store: true`, scene prompt + spoken script, and optional
 * advisor portrait reference image when in "Advisor Avatar Reference" mode.
 */

import { NextRequest, NextResponse } from "next/server";

const CREDIT_LIMIT_SGD = parseFloat(process.env.MONTHLY_CLOUD_CREDIT_LIMIT_SGD || "12.83");
const BACKUP_TRIGGER_SGD = parseFloat(process.env.MANUAL_BACKUP_TRIGGER_SGD || "11.50");
const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";
const INTERACTIONS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

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

function extractVideoFromInteraction(interaction: Record<string, unknown>, geminiKey: string) {
  const outputs = Array.isArray(interaction?.outputs)
    ? (interaction.outputs as Array<Record<string, unknown>>)
    : [];

  for (const item of outputs) {
    const itemType = String(item?.type || "").toLowerCase();
    const mimeType = String(item?.mime_type || item?.mimeType || "video/mp4");

    if (itemType === "video" || mimeType.startsWith("video/")) {
      if (typeof item?.data === "string" && item.data) {
        return { videoDataUri: `data:${mimeType};base64,${item.data}`, videoUrl: null };
      }
      const rawUri = (item?.uri || item?.url || item?.file_uri || item?.fileUri) as string | undefined;
      if (rawUri) {
        const sep = rawUri.includes("?") ? "&" : "?";
        const videoUrl = rawUri.includes("generativelanguage.googleapis.com")
          ? `${rawUri}${sep}key=${encodeURIComponent(geminiKey)}`
          : rawUri;
        return { videoUrl, videoDataUri: null };
      }
    }

    // Check nested content/parts arrays if present
    const nestedParts = Array.isArray(item?.content)
      ? (item.content as Array<Record<string, unknown>>)
      : Array.isArray(item?.parts)
        ? (item.parts as Array<Record<string, unknown>>)
        : [];
    for (const part of nestedParts) {
      const pMime = String(part?.mime_type || part?.mimeType || "");
      if (part?.type === "video" || pMime.startsWith("video/")) {
        if (typeof part?.data === "string" && part.data) {
          return { videoDataUri: `data:${pMime || "video/mp4"};base64,${part.data}`, videoUrl: null };
        }
        const pUri = (part?.uri || part?.url || part?.file_uri) as string | undefined;
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
  return { videoUrl: null, videoDataUri: null };
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
          error: "Interactions API HTTP 401: GEMINI_API_KEY is missing in Vercel environment variables",
          model: OMNI_VIDEO_MODEL
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    const clampedDur = Math.min(15, Math.max(8, Number(durationSec) || 10));
    const durationTag = `${clampedDur}s`;
    const aspectRatio = "9:16";

    const fullPrompt = spokenScript
      ? `${prompt}\nSpoken Dialogue (45yo Singaporean Chinese male English advisor, warm baritone, ${durationTag}): "${spokenScript}"\nTarget Format: ${aspectRatio} vertical video, duration ${durationTag}. Strictly no burned-in text, no captions, no watermarks, no logos.`
      : `${prompt}\nTarget Format: ${aspectRatio} vertical video, duration ${durationTag}. Strictly no burned-in text, no captions, no watermarks, no logos.`;

    // Build Gemini Interactions API multimodal input array
    const inputContent: Array<Record<string, unknown>> = [
      {
        type: "text",
        text: fullPrompt
      }
    ];

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

    const interactionPayload: Record<string, unknown> = {
      model: OMNI_VIDEO_MODEL,
      input: inputContent,
      background: true,
      store: true,
      response_modalities: ["VIDEO"],
      generation_config: {
        duration: durationTag,
        aspect_ratio: aspectRatio
      }
    };

    const resp = await fetch(INTERACTIONS_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiKey
      },
      body: JSON.stringify(interactionPayload)
    });

    const rawText = await resp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { rawBody: rawText };
    }

    if (!resp.ok) {
      console.error("[/api/video/start] Gemini Interactions API rejected request:", {
        endpoint: INTERACTIONS_BASE_URL,
        model: OMNI_VIDEO_MODEL,
        status: resp.status,
        body: parsed
      });

      const errObj = (parsed?.error || {}) as Record<string, unknown>;
      const detail = errObj?.message
        ? String(errObj.message)
        : rawText.slice(0, 240) || resp.statusText;

      return NextResponse.json(
        {
          ok: false,
          status: "FAILED",
          upstreamStatus: resp.status,
          upstreamBody: parsed,
          error: `Interactions API HTTP ${resp.status} (${OMNI_VIDEO_MODEL}): ${detail}`
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    const interactionId = String(parsed?.id || parsed?.name || "").trim();
    const interactionStatus = String(parsed?.status || "in_progress").toLowerCase();

    if (!interactionId) {
      console.error("[/api/video/start] Interactions API returned 200 without interaction.id:", parsed);
      return NextResponse.json(
        {
          ok: false,
          status: "FAILED",
          upstreamStatus: 502,
          upstreamBody: parsed,
          error: "Interactions API HTTP 502: Missing interaction.id in response"
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    // If the interaction already completed synchronously
    if (interactionStatus === "completed") {
      const media = extractVideoFromInteraction(parsed, geminiKey);
      if (media.videoDataUri || media.videoUrl) {
        return NextResponse.json(
          {
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
            triggerManualBackupDrawer: spend + estCost >= BACKUP_TRIGGER_SGD
          },
          { status: 200, headers: corsHeaders() }
        );
      }
    }

    // Return interaction.id immediately to client for async polling via /api/video/status
    return NextResponse.json(
      {
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
        triggerManualBackupDrawer: spend + estCost >= BACKUP_TRIGGER_SGD
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
        error: `Interactions API HTTP 500: ${message}`
      },
      { status: 200, headers: corsHeaders() }
    );
  }
}
