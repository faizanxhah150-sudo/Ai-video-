// ╔══════════════════════════════════════════════════════════════╗
// ║  api/generate.js  —  Vercel Serverless Proxy                ║
// ║  Browser → THIS → HuggingFace (server-to-server, no CORS)  ║
// ╚══════════════════════════════════════════════════════════════╝

const MODELS = [
  "cerspense/zeroscope_v2_576w",
  "damo-vilab/text-to-video-ms-1.7b",
];

// All possible CORS headers - covers every browser/preflight case
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin",      "*");
  res.setHeader("Access-Control-Allow-Methods",     "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",     "Content-Type,Authorization,Accept");
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.setHeader("Access-Control-Max-Age",           "86400");
}

module.exports = async function handler(req, res) {
  setCORS(res);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Health check
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", models: MODELS });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Parse body safely
  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch (_) {}

  const { prompt, modelIndex = 0 } = body;

  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: "prompt is required" });
  }

  const idx     = Math.max(0, Math.min(Number(modelIndex) || 0, MODELS.length - 1));
  const modelId = MODELS[idx];
  const HF_URL  = `https://api-inference.huggingface.co/models/${modelId}`;

  // Token: Vercel env var (set in dashboard) → fallback hardcoded
  const HF_TOKEN = process.env.HF_TOKEN ||
                   "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";

  console.log(`[API] POST prompt="${String(prompt).slice(0, 60)}" model=${modelId}`);

  try {
    const hfRes = await fetch(HF_URL, {
      method:  "POST",
      headers: {
        "Authorization":  `Bearer ${HF_TOKEN}`,
        "Content-Type":   "application/json",
        "Accept":         "video/mp4, application/octet-stream, */*",
        "x-use-cache":    "false",
        "x-wait-for-model": "true",   // Ask HF to wait if model is loading
      },
      body: JSON.stringify({
        inputs: String(prompt).trim(),
        parameters: {
          num_inference_steps: 25,
          guidance_scale: 7.5,
          num_frames: 24,
          fps: 8,
        },
      }),
    });

    console.log(`[API] HF responded: ${hfRes.status} ${hfRes.statusText}`);

    // ── 503: Model still loading ──────────────────────────────────
    if (hfRes.status === 503) {
      let eta = 30;
      try {
        const txt = await hfRes.text();
        const j   = JSON.parse(txt);
        eta = j.estimated_time || 30;
      } catch (_) {}
      return res.status(503).json({
        error:          "model_loading",
        estimated_time: eta,
        model:          modelId,
        message:        `Model ${modelId} is loading, retry in ${eta}s`,
      });
    }

    // ── 401: Bad token ────────────────────────────────────────────
    if (hfRes.status === 401) {
      return res.status(401).json({
        error:   "invalid_token",
        message: "HuggingFace token invalid or expired. Set HF_TOKEN in Vercel env vars.",
      });
    }

    // ── 403: Model access denied ──────────────────────────────────
    if (hfRes.status === 403) {
      return res.status(403).json({
        error:   "access_denied",
        message: "Model requires PRO subscription or gated access.",
      });
    }

    // ── 429: Rate limit ───────────────────────────────────────────
    if (hfRes.status === 429) {
      return res.status(429).json({
        error:   "rate_limited",
        message: "Too many requests. Wait 60 seconds and retry.",
      });
    }

    // ── 404: Wrong model or endpoint ──────────────────────────────
    if (hfRes.status === 404) {
      return res.status(404).json({
        error:   "model_not_found",
        message: `Model ${modelId} not found on HuggingFace inference API.`,
      });
    }

    // ── Any other non-OK ──────────────────────────────────────────
    if (!hfRes.ok) {
      let errBody = `HTTP ${hfRes.status}`;
      try {
        const ct = hfRes.headers.get("content-type") || "";
        if (ct.includes("json")) {
          const j = await hfRes.json();
          errBody = j.error || j.message || errBody;
        } else {
          errBody = (await hfRes.text()).slice(0, 300) || errBody;
        }
      } catch (_) {}
      console.error(`[API] HF error: ${errBody}`);
      return res.status(hfRes.status).json({ error: errBody });
    }

    // ── SUCCESS: stream video to client ──────────────────────────
    const arrayBuf = await hfRes.arrayBuffer();
    const bytes    = Buffer.from(arrayBuf);

    if (!bytes || bytes.length < 100) {
      return res.status(502).json({
        error:   "empty_response",
        message: "HuggingFace returned empty video. Try again.",
      });
    }

    const ct    = hfRes.headers.get("content-type") || "";
    const mime  = ct.startsWith("video/") ? ct : "video/mp4";

    console.log(`[API] ✅ Video ready: ${bytes.length} bytes, ${mime}, model=${modelId}`);

    res.setHeader("Content-Type",        mime);
    res.setHeader("Content-Length",      bytes.length);
    res.setHeader("X-Model-Used",        modelId);
    res.setHeader("Cache-Control",       "no-store");
    return res.status(200).send(bytes);

  } catch (err) {
    console.error(`[API] Unexpected error: ${err.message}`);
    return res.status(500).json({
      error:   "server_error",
      message: err.message,
    });
  }
};
