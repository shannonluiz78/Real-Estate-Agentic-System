/**
 * AgentZug V4.7 — /api/media
 * Serverless Media Synthesis Endpoint (Vercel & Google Cloud Run)
 *
 * Upgraded Nano Banana 2 Lite (gemini-3.1-flash-lite-image) + Dynamic SP-05 Topic-Specific Scene Engine:
 *  - Dynamically generates 3 distinct, topic-specific Singapore real estate B-roll visual scene
 *    prompts tailored to the active OPS-01 topic, category, and headline (never generic templates).
 *  - Strictly enforces "Strictly no text, no letters, no numbers, no watermarks, no logos, no people."
 *  - Calls gemini-3.1-flash-lite-image with generationConfig: { responseModalities: ["IMAGE"] }.
 *  - Enforces SP-12 S$12.83/mo Google Cloud credit cap and graceful fallback to "curated-fallback".
 */

const CREDIT_LIMIT_SGD = parseFloat(process.env.MONTHLY_CLOUD_CREDIT_LIMIT_SGD || "12.83");
const BACKUP_TRIGGER_SGD = parseFloat(process.env.MANUAL_BACKUP_TRIGGER_SGD || "11.50");
const NANO_BANANA_2_LITE_MODEL = process.env.MODEL_IMAGE_GEN || "gemini-3.1-flash-lite-image";
const TEXT_PLANNER_MODEL = process.env.MODEL_SPECIALIST_FREE || "gemini-flash-lite-latest";

const STRICT_NO_TEXT_RULE = "Strictly no text, no letters, no numbers, no watermarks, no logos, no people.";

/**
 * Dynamically builds 3 distinct, topic-specific Singapore architectural/lifestyle B-roll scene
 * descriptions tailored to the exact active OPS-01 topic & headline (no generic placeholders).
 */
function buildTopicTailoredBrollDescriptors({ topic = "", category = "HDB_MOP", headline = "" }) {
  const combined = `${topic} ${headline}`.toLowerCase();
  const cat = String(category || "HDB_MOP").toUpperCase();

  // Case 1: RCR Resale vs OCR New Launch / PSF Gap / Dumbbell Floorplans
  if (/rcr|ocr|psf|dumbbell|new launch|freehold|d15|east coast/.test(combined) || cat === "NEW_LAUNCH") {
    return [
      {
        window: "00:08–00:11.5s",
        title: "City-Fringe RCR Condo vs Suburban Launch Architecture",
        desc: "Architectural contrast of mature Singapore city-fringe District 15 boutique residential towers framed against modern suburban sky-terrace condominium architecture bathed in warm golden-hour light"
      },
      {
        window: "00:18–00:21.5s",
        title: "3-Bedroom Dumbbell Study & Dining Floorplan Interior",
        desc: "Wide architectural interior view of an efficient Singapore 3-bedroom dumbbell-layout living, dining, and open study zone with zero hallway corridor waste, warm timber flooring, and floor-to-ceiling glass"
      },
      {
        window: "00:27–00:30.5s",
        title: "Singapore Heartland MRT Integrated Hub & Promenade",
        desc: "Elevated architectural vista of a modern Singapore MRT integrated transport hub, sheltered garden linkway, and vibrant residential town plaza at sunset"
      }
    ];
  }

  // Case 2: CPF Age-95 Rule / Remaining Lease Decay / Older HDB Repositioning
  if (/age-95|lease|decay|older hdb|remaining|99-yr|reset/.test(combined) || cat === "POLICY_TAX") {
    return [
      {
        window: "00:08–00:11.5s",
        title: "Mature 1980s Heartland Estate vs Fresh 99-Yr Skyline",
        desc: "Architectural perspective looking from a mature Singapore heartland residential precinct across lush green parklands toward newly completed 99-year leasehold sky-bridge condominium towers at golden hour"
      },
      {
        window: "00:18–00:21.5s",
        title: "Renovated High-Floor Singapore Apartment Living & Study",
        desc: "Sunlit high-floor Singapore residential living and dining room with clean minimalist oak cabinetry, travertine stone counter, and panoramic unblocked city skyline windows"
      },
      {
        window: "00:27–00:30.5s",
        title: "Singapore Marina Bay Financial & Policy District at Dusk",
        desc: "Twilight architectural photography of Singapore's Marina Bay financial district glass towers and waterfront promenade reflecting warm amber evening light"
      }
    ];
  }

  // Case 3: HDB 5-Year MOP Wave / Upgrading / ABSD Remission / TDSR
  if (/mop|5-year|5 year|upgrad|absd|tdsr|bto|hdb/.test(combined) || cat === "HDB_MOP") {
    return [
      {
        window: "00:08–00:11.5s",
        title: "Newly MOP Singapore HDB Sky-Terrace BTO Precinct",
        desc: "Golden-hour architectural photography of modern Singapore HDB sky-terrace residential blocks with landscaped rooftop gardens overlooking a lush tropical park connector"
      },
      {
        window: "00:18–00:21.5s",
        title: "Private Condo Balcony & Infinity Pool Progression Vista",
        desc: "Sunlit Singapore private condominium balcony and cantilevered sky-pool deck overlooking manicured tropical landscaping and city skyline at sunset"
      },
      {
        window: "00:27–00:30.5s",
        title: "Singapore Neighbourhood Town Hub & MRT Linkway",
        desc: "Clean architectural view of a modern Singapore residential town centre, elevated MRT viaduct, and tree-lined greenway bathed in warm late-afternoon sunlight"
      }
    ];
  }

  // Case 4: Custom / Dynamic Topic Tailored Synthesis
  const cleanTopic = String(topic || headline || "Singapore Residential Property").trim();
  return [
    {
      window: "00:08–00:11.5s",
      title: `Architectural Exterior: ${cleanTopic.slice(0, 34)}`,
      desc: `Golden-hour architectural exterior of modern Singapore residential towers and landscaped sky-terraces tailored to the theme "${cleanTopic}"`
    },
    {
      window: "00:18–00:21.5s",
      title: `Interior Spatial Layout: ${cleanTopic.slice(0, 34)}`,
      desc: `Sunlit modern Singapore residential open-concept living, dining, and study interior with floor-to-ceiling windows reflecting "${cleanTopic}"`
    },
    {
      window: "00:27–00:30.5s",
      title: `Connectivity & Skyline: ${cleanTopic.slice(0, 34)}`,
      desc: `Panoramic Singapore MRT neighbourhood hub and Marina Bay skyline at dusk contextualizing "${cleanTopic}"`
    }
  ];
}

/**
 * Optional Gemini Flash-Lite SP-05 enhancement to generate 3 ultra-specific visual scene descriptions
 * when GEMINI_API_KEY is available.
 */
async function refineBrollScenesWithGemini({ geminiKey, topic, category, headline }) {
  if (!geminiKey) return null;
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(TEXT_PLANNER_MODEL)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: `You are SP-05 (Singapore Real Estate Visual Director). Given topic="${topic}", headline="${headline}", category="${category}", output strict JSON with 3 distinct, topic-specific Singapore architectural/lifestyle B-roll scene descriptions (NO generic titles, NO people, NO text/numbers/signs):
{
  "scenes": [
    { "title": "short 4-6 word topic-specific title", "desc": "detailed photorealistic architectural/lifestyle scene description for 00:08-00:11.5s" },
    { "title": "short 4-6 word topic-specific title", "desc": "detailed photorealistic architectural/lifestyle scene description for 00:18-00:21.5s" },
    { "title": "short 4-6 word topic-specific title", "desc": "detailed photorealistic architectural/lifestyle scene description for 00:27-00:30.5s" }
  ]
}`
          }]
        }],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: "application/json"
        }
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.scenes) && parsed.scenes.length >= 3) {
      const windows = ["00:08–00:11.5s", "00:18–00:21.5s", "00:27–00:30.5s"];
      return windows.map((win, idx) => ({
        window: win,
        title: String(parsed.scenes[idx].title || `Topic Scene ${idx + 1}`).trim(),
        desc: String(parsed.scenes[idx].desc || "").trim()
      }));
    }
  } catch (e) {
    // Fall back to deterministic topic-tailored builder
  }
  return null;
}

function buildSp05TopicScenePrompt({ topic = "", category = "HDB_MOP", headline = "", aspectLabel = "vertical 4:5 portrait", variationSeed = "" }) {
  const descriptors = buildTopicTailoredBrollDescriptors({ topic, category, headline });
  const primaryScene = descriptors[0].desc;
  const layoutFraming = "Composed with clean, uncluttered dark navy and twilight shadow negative space across the top third and bottom quarter of the frame to allow crisp editorial typography overlay in post-production.";
  const seedTag = variationSeed ? ` Architectural lighting variation ${variationSeed}.` : "";

  return `Create a ${aspectLabel} Singapore real estate architectural photograph tailored to "${topic || headline}". ${primaryScene}. ${layoutFraming}${seedTag} ${STRICT_NO_TEXT_RULE}`;
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

  // SP-12 FinOps Budget Guard
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
  // 2. 9:16 Topic-Specific Video B-Roll Cutaway Refresh (3 slots)
  // ---------------------------------------------------------------------------
  if (mediaType === "BROLL_CUTAWAYS_9X16") {
    const aiDescriptors = await refineBrollScenesWithGemini({
      geminiKey,
      topic: topic || headline,
      category,
      headline: headline || topic
    });
    const descriptors = aiDescriptors || buildTopicTailoredBrollDescriptors({
      topic: topic || headline,
      category,
      headline: headline || topic
    });

    const slotPrompts = descriptors.map((slot, idx) => {
      const prompt = `Create a vertical 9:16 tall Singapore real estate architectural photograph tailored to "${topic || headline}" (${category}): ${slot.desc}. Composed with clean dark shadow negative space in the top third and bottom quarter of the vertical frame for overlay graphics. ${STRICT_NO_TEXT_RULE}`;
      return {
        slotIndex: idx,
        window: cutaways?.[idx]?.window || slot.window,
        title: slot.title,
        desc: slot.desc,
        prompt
      };
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
          title: s.title,
          desc: s.desc,
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
            title: slot.title,
            desc: slot.desc,
            prompt: slot.prompt,
            source: "nano-banana-2-lite",
            imageDataUri: resImg.imageDataUri
          });
        } else {
          lastError = resImg.error || "Rate-limited or unavailable";
          results.push({
            slotIndex: slot.slotIndex,
            window: slot.window,
            title: slot.title,
            desc: slot.desc,
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
          title: slot.title,
          desc: slot.desc,
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

  return res.status(200).json({
    ok: true,
    mode: "NANO_BANANA_2_LITE_AND_OMNI_1_2_FLASH",
    avatarModel: process.env.MODEL_AVATAR_VIDEO || "gemini-omni-1.2-flash",
    brollModel: process.env.MODEL_VIDEO_BROLL || "veo-3.1-lite-generate-001",
    imageModel: NANO_BANANA_2_LITE_MODEL,
    scriptChars: scriptText.length
  });
}
