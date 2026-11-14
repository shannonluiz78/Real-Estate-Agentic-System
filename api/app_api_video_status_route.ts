/**
 * AgentZug V4.7 — app/api/video/status/route.ts
 * Next.js App Router Route Handler for /api/video/status
 * Polls Google Gemini operation status using GEMINI_API_KEY and forwards exact upstream status/body on error.
 */

import { NextRequest, NextResponse } from "next/server";

const OMNI_VIDEO_MODEL = process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders() });
}

async function handlePoll(operationId: string) {
  const geminiKey = process.env.GEMINI_API_KEY || "";
  if (!operationId) {
    return NextResponse.json(
      { ok: false, status: "FAILED", upstreamStatus: 400, error: "operationId is required" },
      { status: 400, headers: corsHeaders() }
    );
  }

  if (!geminiKey) {
    return NextResponse.json(
      { ok: false, status: "FAILED", upstreamStatus: 401, error: "Upstream Gemini HTTP 401: GEMINI_API_KEY missing in Vercel .env" },
      { status: 200, headers: corsHeaders() }
    );
  }

  try {
    const cleanOpPath = operationId.startsWith("operations/") || operationId.startsWith("models/")
      ? operationId
      : `operations/${operationId}`;
    const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${cleanOpPath}?key=${encodeURIComponent(geminiKey)}`;

    const resp = await fetch(pollUrl, { method: "GET" });
    const rawText = await resp.text();
    let opData: Record<string, unknown> = {};
    try {
      opData = JSON.parse(rawText);
    } catch {
      opData = { rawBody: rawText };
    }

    if (!resp.ok) {
      console.error("[/api/video/status] Upstream poll error:", { status: resp.status, body: opData });
      const errDetail = (opData?.error as Record<string, unknown>)?.message
        ? String((opData.error as Record<string, unknown>).message)
        : rawText.slice(0, 200);
      return NextResponse.json(
        {
          ok: false,
          status: "FAILED",
          upstreamStatus: resp.status,
          upstreamBody: opData,
          error: `Upstream Gemini Poll HTTP ${resp.status}: ${errDetail}`
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    if (opData.error) {
      const errObj = opData.error as Record<string, unknown>;
      console.error("[/api/video/status] Operation returned error object:", errObj);
      return NextResponse.json(
        {
          ok: false,
          status: "FAILED",
          upstreamStatus: Number(errObj.code || 500),
          upstreamBody: opData,
          error: `Upstream Gemini HTTP ${errObj.code || 500}: ${String(errObj.message || "Operation failed").slice(0, 200)}`
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    if (!opData.done) {
      return NextResponse.json(
        {
          ok: true,
          status: "RUNNING",
          source: OMNI_VIDEO_MODEL,
          metadata: opData.metadata || null
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    const responseObj = (opData.response || {}) as Record<string, unknown>;
    const genVidResp = (responseObj.generateVideoResponse || {}) as Record<string, unknown>;
    const generatedSamples = (
      Array.isArray(genVidResp.generatedSamples)
        ? genVidResp.generatedSamples
        : Array.isArray(responseObj.predictions)
          ? responseObj.predictions
          : []
    ) as Array<Record<string, unknown>>;

    const firstSample = generatedSamples[0] || {};
    const videoObj = (firstSample.video || {}) as Record<string, unknown>;
    const rawVideoUri = (videoObj.uri || firstSample.uri || null) as string | null;
    const base64Video = (firstSample.bytesBase64Encoded || videoObj.bytesBase64Encoded || null) as string | null;

    if (base64Video) {
      return NextResponse.json(
        {
          ok: true,
          status: "DONE",
          source: OMNI_VIDEO_MODEL,
          videoDataUri: `data:video/mp4;base64,${base64Video}`
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    if (rawVideoUri) {
      const sep = rawVideoUri.includes("?") ? "&" : "?";
      const fetchableUrl = rawVideoUri.includes("generativelanguage.googleapis.com")
        ? `${rawVideoUri}${sep}key=${encodeURIComponent(geminiKey)}`
        : rawVideoUri;
      return NextResponse.json(
        {
          ok: true,
          status: "DONE",
          source: OMNI_VIDEO_MODEL,
          videoUrl: fetchableUrl
        },
        { status: 200, headers: corsHeaders() }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        status: "FAILED",
        upstreamStatus: 204,
        upstreamBody: opData,
        error: "Upstream Gemini HTTP 204: Operation completed without a video output sample"
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
        error: `Upstream Gemini HTTP 500: ${message}`
      },
      { status: 200, headers: corsHeaders() }
    );
  }
}

export async function GET(req: NextRequest) {
  const operationId = req.nextUrl.searchParams.get("operationId") || "";
  return handlePoll(operationId);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const operationId = String(body.operationId || "").trim();
  return handlePoll(operationId);
}
