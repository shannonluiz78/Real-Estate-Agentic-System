/**
 * AgentZug V4.7 — app/api/video/status/route.ts
 * Google Gemini Interactions API Poller for gemini-omni-1.2-flash
 *
 * Polls GET https://generativelanguage.googleapis.com/v1beta/interactions/{id}
 * with `x-goog-api-key: GEMINI_API_KEY`. Extracts the playable video URI or base64
 * video data from `interaction.steps[]` (`type: "model_output"` -> `content[]`) or
 * `interaction.outputs[]`, and forwards exact error status/message on failure.
 */

import { NextRequest, NextResponse } from "next/server";

const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";
const INTERACTIONS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
  const textNotes: string[] = [];

  // 1. Primary REST schema: interaction.steps[] -> step.content[]
  if (Array.isArray(interaction?.steps)) {
    for (const step of interaction.steps as Array<Record<string, unknown>>) {
      if (step && typeof step === "object") {
        const stepType = String(step.type || "").toLowerCase();
        candidateCollections.push(step);
        if (Array.isArray(step.content)) {
          for (const part of step.content as Array<Record<string, unknown>>) {
            if (part && typeof part === "object") {
              candidateCollections.push(part);
              if (stepType === "model_output" && part.type === "text" && typeof part.text === "string") {
                textNotes.push(part.text);
              }
            }
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

  // 3. Top-level output / result fallback
  for (const key of ["output", "result"]) {
    const obj = interaction?.[key];
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      candidateCollections.push(obj as Record<string, unknown>);
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
          videoUrl: null,
          modelTextNote: textNotes.join(" ").trim()
        };
      }
      const rawUri = (item?.uri || item?.url || item?.file_uri || item?.fileUri) as string | undefined;
      if (typeof rawUri === "string" && rawUri.length > 0) {
        return {
          videoUrl: appendApiKeyIfNeeded(rawUri, geminiKey),
          videoDataUri: null,
          modelTextNote: textNotes.join(" ").trim()
        };
      }
    }
  }

  return {
    videoUrl: null,
    videoDataUri: null,
    modelTextNote: textNotes.join(" ").trim()
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders() });
}

async function handlePoll(interactionId: string, initialVideoUrl = "") {
  const geminiKey = process.env.GEMINI_API_KEY || "";
  if (!interactionId) {
    return NextResponse.json(
      { ok: false, status: "FAILED", upstreamStatus: 400, error: "interactionId is required" },
      { status: 400, headers: corsHeaders() }
    );
  }

  if (!geminiKey) {
    return NextResponse.json(
      {
        ok: false,
        status: "FAILED",
        upstreamStatus: 401,
        error: "Interactions API HTTP 401: GEMINI_API_KEY missing in Vercel .env"
      },
      { status: 200, headers: corsHeaders() }
    );
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
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { rawBody: rawText };
    }

    if (!resp.ok) {
      console.error("[/api/video/status] Gemini Interactions poll error:", {
        interactionId: cleanId,
        status: resp.status,
        body: data
      });
      const errDetail = (data?.error as Record<string, unknown>)?.message
        ? String((data.error as Record<string, unknown>).message)
        : rawText.slice(0, 220) || resp.statusText;
      return NextResponse.json(
        {
          ok: false,
          status: "FAILED",
          upstreamStatus: resp.status,
          upstreamBody: data,
          error: `Interactions Poll HTTP ${resp.status}: ${errDetail}`
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    const iStatus = String(data?.status || "").toLowerCase();

    if (iStatus === "failed" || iStatus === "cancelled" || data?.error) {
      const errObj = (data?.error || {}) as Record<string, unknown>;
      const code = Number(errObj?.code || 500);
      const msg = String(errObj?.message || data?.status_message || `Interaction ${iStatus || "failed"}`).slice(0, 220);
      console.error("[/api/video/status] Interaction failed:", { interactionId: cleanId, status: iStatus, body: data });
      return NextResponse.json(
        {
          ok: false,
          status: "FAILED",
          upstreamStatus: code,
          upstreamBody: data,
          error: `Interactions API HTTP ${code}: ${msg}`
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    if (iStatus !== "completed" && data?.done !== true) {
      return NextResponse.json(
        {
          ok: true,
          status: "RUNNING",
          interactionId: cleanId,
          interactionStatus: iStatus || "in_progress",
          source: OMNI_VIDEO_MODEL
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    // Interaction completed — extract video URI or base64 data from steps[] or outputs[]
    const media = extractVideoFromInteraction(data, geminiKey);
    const resolvedUrl = media.videoUrl || (initialVideoUrl ? appendApiKeyIfNeeded(initialVideoUrl, geminiKey) : null);

    if (media.videoDataUri || resolvedUrl) {
      return NextResponse.json(
        {
          ok: true,
          status: "DONE",
          interactionId: cleanId,
          interactionStatus: "completed",
          source: OMNI_VIDEO_MODEL,
          videoUrl: resolvedUrl,
          videoDataUri: media.videoDataUri
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    console.error("[/api/video/status] Interaction completed without video part in steps/outputs:", data);
    const noteSuffix = media.modelTextNote ? `: ${media.modelTextNote.slice(0, 180)}` : "";
    return NextResponse.json(
      {
        ok: false,
        status: "FAILED",
        upstreamStatus: 204,
        upstreamBody: data,
        error: `Interactions API HTTP 204: Interaction completed without a playable video output step${noteSuffix}`
      },
      { status: 200, headers: corsHeaders() }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Polling error";
    console.error("[/api/video/status] Unhandled exception:", err);
    return NextResponse.json(
      {
        ok: false,
        status: "FAILED",
        upstreamStatus: 500,
        error: `Interactions Poll HTTP 500: ${message}`
      },
      { status: 200, headers: corsHeaders() }
    );
  }
}

export async function GET(req: NextRequest) {
  const interactionId =
    req.nextUrl.searchParams.get("interactionId") ||
    req.nextUrl.searchParams.get("operationId") ||
    "";
  const initialVideoUrl = req.nextUrl.searchParams.get("initialVideoUrl") || "";
  return handlePoll(interactionId, initialVideoUrl);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const interactionId = String(body.interactionId || body.operationId || "").trim();
  const initialVideoUrl = String(body.initialVideoUrl || "").trim();
  return handlePoll(interactionId, initialVideoUrl);
}
