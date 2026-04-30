import { mintScribeToken } from "../../server/elevenlabs/scribeToken.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey =
    process.env.ELEVENLABS_API_KEY || process.env.VITE_ELEVENLABS_API_KEY;

  if (!apiKey) {
    res.status(500).json({
      error:
        "Missing ELEVENLABS_API_KEY on the server. Add it to your Vercel environment variables.",
    });
    return;
  }

  try {
    const token = await mintScribeToken(apiKey);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ token });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to mint token.",
    });
  }
}
