/**
 * AgentZug V4.7 — app/api/video/status/route.ts
 * Google Gemini Interactions API Poller for gemini-omni-1.2-flash
 *
 * Polls GET https://generativelanguage.googleapis.com/v1beta/interactions/{id}
 * with `x-goog-api-key: GEMINI_API_KEY`. Extracts video URI or base64 video data
 * from completed interaction output steps, or forwards exact error status/message.
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

  // Also check top-level output / result fallback fields
  const singleOutput = (interaction?.output || interaction?.result) as Record<string, unknown> | undefined;
  if (singleOutput && typeof singleOutput === "object") {
    const sMime = String(singleOutput?.mime_type || singleOutput?.mimeType || "video/mp4");
    if (typeof singleOutput?.data === "string" && singleOutput.data) {
      return { videoDataUri: `data:${sMime};base64,${singleOutput.data}`, videoUrl: null };
    }
    const sUri = (singleOutput?.uri || singleOutput?.url || singleOutput?.file_uri) as string | undefined;
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

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders() });
}

async function handlePoll(interactionId: string) {
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

    // Interaction completed — extract video URI or base64 data from output steps
    const media = extractVideoFromInteraction(data, geminiKey);
    if (media.videoDataUri || media.videoUrl) {
      return NextResponse.json(
        {
          ok: true,
          status: "DONE",
          interactionId: cleanId,
          interactionStatus: "completed",
          source: OMNI_VIDEO_MODEL,
          videoUrl: media.videoUrl,
          videoDataUri: media.videoDataUri
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    console.error("[/api/video/status] Interaction completed without video output:", data);
    return NextResponse.json(
      {
        ok: false,
        status: "FAILED",
        upstreamStatus: 204,
        upstreamBody: data,
        error: "Interactions API HTTP 204: Interaction completed without a playable video output step"
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
  return handlePoll(interactionId);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const interactionId = String(body.interactionId || body.operationId || "").trim();
  return handlePoll(interactionId);
}
