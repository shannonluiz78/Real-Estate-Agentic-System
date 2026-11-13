/**
 * AgentZug V4.7 — /api/media
 * Serverless Media Synthesis Endpoint (Vercel & Google Cloud Run)
 *
 * Upgraded Nano Banana 2 Lite (gemini-3.1-flash-lite-image) Pipeline:
 *  - Calls https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent
 *    with generationConfig: { responseModalities: ["IMAGE"] } using server-side GEMINI_API_KEY.
 *  - SP-05 converts the active OPS-01 topic, category (HDB_MOP, NEW_LAUNCH, POLICY_TAX, etc.),
 *    and headline into a Singapore real estate architectural/lifestyle scene prompt with clean dark
 *    negative space in the top third and bottom quarter for HTML/CSS canvas typography overlay.
 *  - Strictly enforces "no text, no letters, no numbers, no watermarks, no logos, no people" so all
 *    headlines, data pills, and CEA Circular 02/2011 disclosures render crisply on the client canvas.
 *  - Supports both 4:5 CEA Editorial Poster backgrounds (mediaType: "IMAGE_4X5") and 3x 9:16 B-roll
 *    cutaway slots (00:08-00:11.5s, 00:18-00:21.5s, 00:27-00:30.5s) (mediaType: "BROLL_CUTAWAYS_9X16").
 *  - Enforces SP-12 S$12.83/mo Google Cloud credit cap and graceful fallback to "curated-fallback".
 */

const CREDIT_LIMIT_SGD = parseFloat(process.env.MONTHLY_CLOUD_CREDIT_LIMIT_SGD || "12.83");
const BACKUP_TRIGGER_SGD = parseFloat(process.env.MANUAL_BACKUP_TRIGGER_SGD || "11.50");
const NANO_BANANA_2_LITE_MODEL = process.env.MODEL_IMAGE_GEN || "gemini-3.1-flash-lite-image";

const STRICT_NO_TEXT_RULE = "Strictly no text, no letters, no numbers, no watermarks, no logos, no people.";

/**
 * SP-05 Lightweight Topic-to-Scene Prompt Builder
 * Converts OPS-01 topic, category, and headline into a Singapore architectural/lifestyle
 * scene with dark negative space in the top third and bottom quarter.
 */
function buildSp05TopicScenePrompt({ topic = "", category = "HDB_MOP", headline = "", aspectLabel = "vertical 4:5 portrait", variationSeed = "" }) {
  const rawContext = `${topic} ${headline}`.toLowerCase();
  const cat = String(category || "HDB_MOP").toUpperCase();

  let sceneCore = "";
  if (cat === "HDB_MOP" || /hdb|mop|5-year|heartland|punggol|tampines|bishan|lease/.test(rawContext)) {
    sceneCore = "Photorealistic golden-hour architectural photography of modern Singapore HDB sky-terrace residential towers overlooking a lush tropical park connector and gleaming private condominium skyline on the horizon, warm sunlight reflecting off glass facades and manicured greenery.";
  } else if (cat === "NEW_LAUNCH" || /d15|rcr|ocr|freehold|condo|dumbbell|floorplan|psf/.test(rawContext)) {
    sceneCore = "Photorealistic luxury Singapore District 15 architectural interior and balcony vista featuring warm Burmese teak flooring, travertine stone surfaces, floor-to-ceiling glass, and an infinity pool deck overlooking the East Coast sea breeze and Marina Bay skyline at sunset.";
  } else if (cat === "POLICY_TAX" || /absd|tdsr|cpf|iras|mas|interest|loan/.test(rawContext)) {
    sceneCore = "Photorealistic editorial architectural photography of Singapore's Marina Bay financial district glass towers at twilight paired with a refined modern residential study interior in warm amber architectural lighting and deep slate stone textures.";
  } else {
    sceneCore = "Photorealistic luxury Singapore residential architecture and Marina Bay skyline panorama at golden hour, sunlit modern condominium sky-garden with lush tropical palms and calm reflective water features.";
  }

  const layoutFraming = "Composed with clean, uncluttered dark navy and twilight shadow negative space across the top third and bottom quarter of the frame to allow crisp editorial typography overlay in post-production.";
  const seedTag = variationSeed ? ` Architectural lighting variation ${variationSeed}.` : "";

  return `Create a ${aspectLabel} Singapore real estate architectural photograph. ${sceneCore} ${layoutFraming}${seedTag} ${STRICT_NO_TEXT_RULE}`;
}

function buildSp05BrollCutawayPrompts({ topic = "", category = "HDB_MOP", headline = "", cutaways = [] }) {
  const defaultSlots = [
    {
      window: "00:08–00:11.5s",
      desc: "Sunlit modern Singapore condominium living room and balcony overlooking Marina Bay skyline at golden hour"
    },
    {
      window: "00:18–00:21.5s",
      desc: "Clean Singapore HDB heartland sky-terrace residential architecture and lush tropical park connector at sunset"
    },
    {
      window: "00:27–00:30.5s",
      desc: "Bright modern 3-bedroom Singapore dumbbell-layout dining and living room interior with warm timber and marble finishes"
    }
  ];

  return defaultSlots.map((slot, idx) => {
    const customDesc = cutaways?.[idx]?.label || cutaways?.[idx]?.prompt || slot.desc;
    const prompt = `Create a vertical 9:16 tall Singapore real estate architectural cutaway photograph inspired by the theme "${topic || headline}" (${category}): ${customDesc}. Composed with clean dark shadow negative space in the top third and bottom quarter of the vertical frame for overlay graphics. ${STRICT_NO_TEXT_RULE}`;
    return {
      slotIndex: idx,
      window: cutaways?.[idx]?.window || slot.window,
      prompt
    };
  });
}

async function generateSingleNanoBanana2LiteImage({ geminiKey, prompt }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(NANO_BANANA_2_LITE_MODEL)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseModalities: ["IMAGE"]
      }
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return {
      ok: false,
      status: resp.status,
      error: `HTTP ${resp.status}: ${errText.slice(0, 180)}`
    };
  }

  const data = await resp.json();
  const inlinePart = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.data);
  if (!inlinePart) {
    return {
      ok: false,
      status: 200,
      error: "No inlineData image returned by gemini-3.1-flash-lite-image"
    };
  }

  const mimeType = inlinePart.inlineData.mimeType || "image/png";
  const imageDataUri = `data:${mimeType};base64,${inlinePart.inlineData.data}`;
  return {
    ok: true,
    imageDataUri,
    mimeType
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const {
    mediaType = "IMAGE_4X5", // "IMAGE_4X5" | "BROLL_CUTAWAYS_9X16" | "VIDEO_PIPELINE"
    topic = "",
    category = "HDB_MOP",
    headline = "",
    cutaways = [],
    scriptText = "",
    currentSpendSgd = 3.42,
    variationSeed = ""
  } = req.body || {};

  const spend = Number(currentSpendSgd || 0);
  const geminiKey = process.env.GEMINI_API_KEY || "";

  // SP-12 FinOps Budget Guard: Enforce S$12.83/mo hard cap & S$11.50 manual backup alert
  if (spend >= CREDIT_LIMIT_SGD) {
    return res.status(200).json({
      ok: true,
      source: "curated-fallback",
      fallbackReason: `SP-12 monthly credit cap (S$${CREDIT_LIMIT_SGD.toFixed(2)}/mo) reached`,
      triggerManualBackupDrawer: true,
      imageDataUri: null,
      cutawayImages: []
    });
  }

  // ---------------------------------------------------------------------------
  // 1. 4:5 CEA Editorial Poster Background (Nano Banana 2 Lite)
  // ---------------------------------------------------------------------------
  if (mediaType === "IMAGE_4X5") {
    const sp05Prompt = buildSp05TopicScenePrompt({
      topic: topic || headline,
      category,
      headline: headline || topic,
      aspectLabel: "vertical 4:5 portrait",
      variationSeed: variationSeed || String(Date.now()).slice(-4)
    });

    if (!geminiKey) {
      return res.status(200).json({
        ok: true,
        source: "curated-fallback",
        fallbackReason: "GEMINI_API_KEY not configured on server",
        agent: "SP-05",
        model: NANO_BANANA_2_LITE_MODEL,
        sp05Prompt,
        imageDataUri: null,
        triggerManualBackupDrawer: spend >= BACKUP_TRIGGER_SGD
      });
    }

    try {
      const genResult = await generateSingleNanoBanana2LiteImage({ geminiKey, prompt: sp05Prompt });
      if (genResult.ok && genResult.imageDataUri) {
        return res.status(200).json({
          ok: true,
          source: "nano-banana-2-lite",
          agent: "SP-05",
          model: NANO_BANANA_2_LITE_MODEL,
          sp05Prompt,
          imageDataUri: genResult.imageDataUri,
          estimatedCostSgd: 0.02,
          triggerManualBackupDrawer: (spend + 0.02) >= BACKUP_TRIGGER_SGD
        });
      }

      return res.status(200).json({
        ok: true,
        source: "curated-fallback",
        fallbackReason: genResult.error || "Nano Banana 2 Lite unavailable",
        agent: "SP-05",
        model: NANO_BANANA_2_LITE_MODEL,
        sp05Prompt,
        imageDataUri: null,
        triggerManualBackupDrawer: spend >= BACKUP_TRIGGER_SGD
      });
    } catch (err) {
      return res.status(200).json({
        ok: true,
        source: "curated-fallback",
        fallbackReason: err.message || "Network error calling Gemini API",
        agent: "SP-05",
        model: NANO_BANANA_2_LITE_MODEL,
        sp05Prompt,
        imageDataUri: null
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 2. 9:16 Video B-Roll Cutaway Refresh (3 slots: 00:08-11.5s, 18-21.5s, 27-30.5s)
  // ---------------------------------------------------------------------------
  if (mediaType === "BROLL_CUTAWAYS_9X16") {
    const slotPrompts = buildSp05BrollCutawayPrompts({
      topic: topic || headline,
      category,
      headline: headline || topic,
      cutaways
    });

    if (!geminiKey) {
      return res.status(200).json({
        ok: true,
        source: "curated-fallback",
        fallbackReason: "GEMINI_API_KEY not configured on server",
        agent: "SP-05",
        model: NANO_BANANA_2_LITE_MODEL,
        cutawayImages: slotPrompts.map(s => ({
          slotIndex: s.slotIndex,
          window: s.window,
          prompt: s.prompt,
          source: "curated-fallback",
          imageDataUri: null
        })),
        triggerManualBackupDrawer: spend >= BACKUP_TRIGGER_SGD
      });
    }

    const results = [];
    let liveCount = 0;
    let lastError = "";

    for (const slot of slotPrompts) {
      try {
        const resImg = await generateSingleNanoBanana2LiteImage({ geminiKey, prompt: slot.prompt });
        if (resImg.ok && resImg.imageDataUri) {
          liveCount += 1;
          results.push({
            slotIndex: slot.slotIndex,
            window: slot.window,
            prompt: slot.prompt,
            source: "nano-banana-2-lite",
            imageDataUri: resImg.imageDataUri
          });
        } else {
          lastError = resImg.error || "Rate-limited or unavailable";
          results.push({
            slotIndex: slot.slotIndex,
            window: slot.window,
            prompt: slot.prompt,
            source: "curated-fallback",
            imageDataUri: null
          });
        }
      } catch (e) {
        lastError = e.message;
        results.push({
          slotIndex: slot.slotIndex,
          window: slot.window,
          prompt: slot.prompt,
          source: "curated-fallback",
          imageDataUri: null
        });
      }
    }

    const overallSource = liveCount > 0 ? "nano-banana-2-lite" : "curated-fallback";
    return res.status(200).json({
      ok: true,
      source: overallSource,
      liveCount,
      totalSlots: 3,
      fallbackReason: liveCount === 0 ? (lastError || "Fallback to curated photo pool") : null,
      agent: "SP-05",
      model: NANO_BANANA_2_LITE_MODEL,
      cutawayImages: results,
      estimatedCostSgd: Number((liveCount * 0.02).toFixed(2)),
      triggerManualBackupDrawer: (spend + liveCount * 0.02) >= BACKUP_TRIGGER_SGD
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Omni 1.2 Flash + Veo 3.1 - Lite Pipeline Status
  // ---------------------------------------------------------------------------
  const veoModel = process.env.MODEL_VIDEO_BROLL || "veo-3.1-lite-generate-001";
  const omniModel = process.env.MODEL_AVATAR_VIDEO || "omni-1.2-flash";

  return res.status(200).json({
    ok: true,
    mode: "IN_APP_LOCKED_AVATAR_SYNTHESIS",
    avatarModel: omniModel,
    brollModel: veoModel,
    imageModel: NANO_BANANA_2_LITE_MODEL,
    cutawayDurationSec: 3.5,
    voiceProfile: "45yo Singaporean Chinese Male English Advisor (Locked)",
    scriptChars: scriptText.length,
    triggerManualBackupDrawer: spend >= BACKUP_TRIGGER_SGD,
    message: "Configured for Omni 1.2 Flash Avatar + Veo 3.1 - Lite 3.5s B-Roll Cutaways + Nano Banana 2 Lite backgrounds."
  });
}
