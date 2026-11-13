/**
 * AgentZug V4.7 — /api/tts
 * Server-Side Locked Male Baritone Voiceover Endpoint (Vercel & Google Cloud Run)
 *
 * Priority Waterfall:
 *  1. Gemini Native TTS (gemini-2.5-flash-preview-tts) using GEMINI_API_KEY
 *     with locked male baritone voice ("Charon") + 45yo Singaporean Chinese male advisor pacing.
 *     Automatically wraps raw PCM (audio/L16) in a standard RIFF/WAV header so browser
 *     HTMLAudioElement & Web Audio MediaRecorder play and capture it natively.
 *  2. Google Cloud Text-to-Speech API (en-SG-Standard-B / en-GB-Neural2-B, ssmlGender: "MALE")
 *     when VERTEX_AI_ACCESS_TOKEN or GOOGLE_TTS_API_KEY is available.
 *  3. Graceful JSON fallback ({ source: "browser-fallback" }) when offline or unconfigured.
 */

const CREDIT_LIMIT_SGD = parseFloat(process.env.MONTHLY_CLOUD_CREDIT_LIMIT_SGD || "12.83");

/**
 * Wraps raw 16-bit signed little-endian PCM bytes in a 44-byte RIFF/WAV header
 */
function wrapPcm16ToWavBuffer(pcmBuffer, sampleRate = 24000, numChannels = 1) {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20);  // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

async function synthesizeWithGeminiTts({ apiKey, scriptText }) {
  const ttsModel = process.env.MODEL_TTS || "gemini-2.5-flash-preview-tts";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ttsModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = `Read the following real estate advisory script in a warm, confident, authoritative 45-year-old Singaporean Chinese male English baritone voice at a steady 140 words per minute:\n\n${scriptText}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Charon"
            }
          }
        }
      }
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return { ok: false, error: `Gemini TTS HTTP ${resp.status}: ${errText.slice(0, 180)}` };
  }

  const data = await resp.json();
  const inlinePart = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.data);
  if (!inlinePart) {
    return { ok: false, error: "No audio inlineData returned by Gemini TTS" };
  }

  const rawMime = String(inlinePart.inlineData.mimeType || "audio/L16;rate=24000");
  const rawBytes = Buffer.from(inlinePart.inlineData.data, "base64");

  // Convert raw PCM (audio/L16 or audio/pcm) to standard browser-playable audio/wav
  if (/l16|pcm/i.test(rawMime)) {
    const rateMatch = rawMime.match(/rate=(\d+)/i);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
    const wavBuf = wrapPcm16ToWavBuffer(rawBytes, sampleRate, 1);
    return {
      ok: true,
      engine: "gemini-2.5-flash-preview-tts",
      voiceLabel: "Locked Male Baritone (Charon • 45yo SG Advisor)",
      audioDataUri: `data:audio/wav;base64,${wavBuf.toString("base64")}`
    };
  }

  return {
    ok: true,
    engine: "gemini-2.5-flash-preview-tts",
    voiceLabel: "Locked Male Baritone (Charon • 45yo SG Advisor)",
    audioDataUri: `data:${rawMime};base64,${rawBytes.toString("base64")}`
  };
}

async function synthesizeWithGoogleCloudTts({ apiKey, bearerToken, scriptText }) {
  const url = bearerToken
    ? "https://texttospeech.googleapis.com/v1/text:synthesize"
    : `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`;

  const headers = { "Content-Type": "application/json" };
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }

  // Try en-SG male first, then en-GB Neural2 male
  const voiceConfigs = [
    { languageCode: "en-SG", name: "en-SG-Standard-B", ssmlGender: "MALE" },
    { languageCode: "en-GB", name: "en-GB-Neural2-B", ssmlGender: "MALE" }
  ];

  for (const vc of voiceConfigs) {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: { text: scriptText },
        voice: vc,
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: 0.98,
          pitch: -1.5
        }
      })
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.audioContent) {
        return {
          ok: true,
          engine: "google-cloud-tts",
          voiceLabel: `Locked Male Baritone (${vc.name})`,
          audioDataUri: `data:audio/mp3;base64,${data.audioContent}`
        };
      }
    }
  }

  return { ok: false, error: "Google Cloud TTS unavailable or unauthenticated" };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const { scriptText = "", currentSpendSgd = 3.42 } = req.body || {};
  const cleanScript = String(scriptText || "").trim();
  if (!cleanScript) {
    return res.status(400).json({ ok: false, error: "scriptText is required" });
  }

  if (Number(currentSpendSgd) >= CREDIT_LIMIT_SGD) {
    return res.status(200).json({
      ok: true,
      source: "browser-fallback",
      fallbackReason: `SP-12 monthly credit cap (S$${CREDIT_LIMIT_SGD.toFixed(2)}/mo) reached`,
      audioDataUri: null
    });
  }

  const geminiKey = process.env.GEMINI_API_KEY || "";
  const vertexToken = process.env.VERTEX_AI_ACCESS_TOKEN || "";

  // 1. Try Gemini Native TTS (Male Baritone "Charon")
  if (geminiKey) {
    try {
      const gemTts = await synthesizeWithGeminiTts({ apiKey: geminiKey, scriptText: cleanScript });
      if (gemTts.ok && gemTts.audioDataUri) {
        return res.status(200).json({
          ok: true,
          source: "server-tts",
          engine: gemTts.engine,
          voiceLabel: gemTts.voiceLabel,
          audioDataUri: gemTts.audioDataUri,
          estimatedCostSgd: 0.01
        });
      }
    } catch (e) {
      // Fall through to Google Cloud TTS
    }
  }

  // 2. Try Google Cloud Text-to-Speech (en-SG-Standard-B / en-GB-Neural2-B Male)
  if (geminiKey || vertexToken) {
    try {
      const cloudTts = await synthesizeWithGoogleCloudTts({
        apiKey: geminiKey,
        bearerToken: vertexToken,
        scriptText: cleanScript
      });
      if (cloudTts.ok && cloudTts.audioDataUri) {
        return res.status(200).json({
          ok: true,
          source: "server-tts",
          engine: cloudTts.engine,
          voiceLabel: cloudTts.voiceLabel,
          audioDataUri: cloudTts.audioDataUri,
          estimatedCostSgd: 0.01
        });
      }
    } catch (e) {
      // Fall through to offline browser fallback
    }
  }

  // 3. Offline / Unconfigured Fallback
  return res.status(200).json({
    ok: true,
    source: "browser-fallback",
    fallbackReason: "GEMINI_API_KEY not configured on server — using offline browser male voice fallback",
    audioDataUri: null
  });
}
