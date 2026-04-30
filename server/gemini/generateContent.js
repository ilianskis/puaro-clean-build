const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

export async function generateGeminiContent({
  apiKey,
  model,
  messages,
  temperature = 0.8,
  expectJson = false,
}) {
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY.");
  }

  if (!model) {
    throw new Error("Missing Gemini model name.");
  }

  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const systemMessages = normalizedMessages.filter((m) => m.role === "system");
  const conversationalMessages = normalizedMessages.filter(
    (m) => m.role !== "system",
  );

  const body = {
    contents: conversationalMessages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: String(message.content ?? "") }],
    })),
    generationConfig: {
      temperature,
      ...(expectJson ? { responseMimeType: "application/json" } : {}),
    },
  };

  if (systemMessages.length) {
    body.system_instruction = {
      parts: [
        {
          text: systemMessages.map((message) => message.content).join("\n\n"),
        },
      ],
    };
  }

  const response = await fetch(
    `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const detail = await readGeminiError(response);
    throw new Error(`Gemini API error ${response.status}: ${detail}`);
  }

  const data = await response.json();
  const text = extractGeminiText(data);
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  return text;
}

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => part?.text ?? "")
    .filter(Boolean)
    .join("")
    .trim();
}

async function readGeminiError(response) {
  let detail = response.statusText;
  try {
    const body = await response.json();
    detail =
      body?.error?.message ??
      body?.error?.status ??
      body?.error?.details?.[0]?.message ??
      detail;
  } catch {
    // ignore parse errors
  }
  return detail;
}
