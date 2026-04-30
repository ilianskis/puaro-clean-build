import { synthesizeElevenLabsSpeech } from "../../server/elevenlabs/tts.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const apiKey =
      body?.customApiKey ||
      process.env.ELEVENLABS_API_KEY ||
      process.env.VITE_ELEVENLABS_API_KEY;

    if (!apiKey) {
      res.status(500).json({
        error:
          "Missing ELEVENLABS_API_KEY on the server. Add it to Vercel or enter your own ElevenLabs key.",
      });
      return;
    }

    const audioBuffer = await synthesizeElevenLabsSpeech({
      apiKey,
      voiceId: body?.voiceId,
      text: body?.text,
      voiceSettings: body?.voiceSettings,
    });

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(Buffer.from(audioBuffer));
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Failed to synthesize speech.",
    });
  }
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
