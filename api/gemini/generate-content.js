import { generateGeminiContent } from "../../server/gemini/generateContent.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error:
        "Missing GEMINI_API_KEY on the server. Add it to your Vercel environment variables.",
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const text = await generateGeminiContent({
      apiKey,
      model: body?.model,
      messages: body?.messages,
      temperature: body?.temperature,
      expectJson: body?.expectJson,
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ text });
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Gemini request failed.",
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
