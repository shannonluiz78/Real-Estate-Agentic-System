/**
 * AgentZug V4.7 — app/api/video/start/route.ts
 * Google Gemini Interactions API Video Starter for gemini-omni-1.2-flash
 *
 * Calls POST https://generativelanguage.googleapis.com/v1beta/interactions
 * with:
 *  - model: "gemini-omni-1.2-flash"
 *  - background: true, store: true
 *  - response_modalities: ["video"]
 *  - response_format: { type: "video", aspect_ratio: "9:16", duration: "<N>s", resolution: "720p", delivery: "uri" }
 *  - multimodal input: optional reference image + scene prompt + spoken script
 */

import { NextRequest, NextResponse } from "next/server";

const CREDIT_LIMIT_SGD = parseFloat(process.env.MONTHLY_CLOUD_CREDIT_LIMIT_SGD || "12.83");
const BACKUP_TRIGGER_SGD = parseFloat(process.env.MANUAL_BACKUP_TRIGGER_SGD || "11.50");
const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";
const INTERACTIONS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

function estimateSceneCostSgd(durationSec = 10, mode = "AVATAR_REF"): number {
  const dur = Math.min(15, Math.max(3, Number(durationSec) || 10));
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

function appendApiKeyIfNeeded(rawUri: string, geminiKey: string): string {
  if (!rawUri) return rawUri;
  if (rawUri.includes("generativelanguage.googleapis.com") && !rawUri.includes("key=")) {
    const sep = rawUri.includes("?") ? "&" : "?";
    return `${rawUri}${sep}key=${encodeURIComponent(geminiKey)}`;
  }
  return rawUri;
}

function extractVideoFromInteraction(interaction: Record<string, unknown>, geminiKey: string) {
  const candidateCollections: Array<Record<string, unknown>> = [];

  // 1. Primary REST schema: interaction.steps[] -> step.content[]
  if (Array.isArray(interaction?.steps)) {
    for (const step of interaction.steps as Array<Record<string, unknown>>) {
      if (step && typeof step === "object") {
        candidateCollections.push(step);
        if (Array.isArray(step.content)) {
          for (const part of step.content as Array<Record<string, unknown>>) {
            if (part && typeof part === "object") candidateCollections.push(part);
          }
        }
        if (Array.isArray(step.parts)) {
          for (const part of step.parts as Array<Record<string, unknown>>) {
            if (part && typeof part === "object") candidateCollections.push(part);
          }
        }
      }
    }
  }

  // 2. Secondary REST schema: interaction.outputs[]
  if (Array.isArray(interaction?.outputs)) {
    for (const out of interaction.outputs as Array<Record<string, unknown>>) {
      if (out && typeof out === "object") {
        candidateCollections.push(out);
        if (Array.isArray(out.content)) {
          for (const part of out.content as Array<Record<string, unknown>>) {
            if (part && typeof part === "object") candidateCollections.push(part);
          }
        }
        if (Array.isArray(out.parts)) {
          for (const part of out.parts as Array<Record<string, unknown>>) {
            if (part && typeof part === "object") candidateCollections.push(part);
          }
        }
      }
    }
  }

  for (const item of candidateCollections) {
    const itemType = String(item?.type || "").toLowerCase();
    const mimeType = String(item?.mime_type || item?.mimeType || "");
    const isVideoPart = itemType === "video" || mimeType.toLowerCase().startsWith("video/");

    if (isVideoPart) {
      if (typeof item?.data === "string" && item.data.length > 0) {
        return {
          videoDataUri: `data:${mimeType || "video/mp4"};base64,${item.data}`,
          videoUrl: null
        };
      }
      const rawUri = (item?.uri || item?.url || item?.file_uri || item?.fileUri) as string | undefined;
      if (typeof rawUri === "string" && rawUri.length > 0) {
        return {
          videoUrl: appendApiKeyIfNeeded(rawUri, geminiKey),
          videoDataUri: null
        };
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

    // Omni 1.2 Flash supports whole seconds from 3s to 15s
    const clampedDur = Math.min(15, Math.max(3, Math.round(Number(durationSec) || 10)));
    const durationTag = `${clampedDur}s`;
    const aspectRatio = "9:16";

    const fullPrompt = spokenScript
      ? `${prompt}\nSpoken Dialogue (45yo Singaporean Chinese male English advisor, warm baritone): "${spokenScript}"\nStrictly no burned-in text, no captions, no watermarks, no logos.`
      : `${prompt}\nStrictly no burned-in text, no captions, no watermarks, no logos.`;

    // Place reference image first followed by text instruction per official Omni cookbook
    const inputContent: Array<Record<string, unknown>> = [];

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

    inputContent.push({
      type: "text",
      text: fullPrompt
    });

    const interactionPayload: Record<string, unknown> = {
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

    // Extract video immediately if already present in steps[] / outputs[]
    const media = extractVideoFromInteraction(parsed, geminiKey);
    if (interactionStatus === "completed" && (media.videoDataUri || media.videoUrl)) {
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

    // Return interaction.id immediately to client for async polling via /api/video/status
    return NextResponse.json(
      {
        ok: true,
        status: "RUNNING",
        interactionId,
        operationId: interactionId,
        interactionStatus,
        initialVideoUrl: media.videoUrl || null,
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
