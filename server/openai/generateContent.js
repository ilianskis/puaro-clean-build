const OPENAI_CHAT_BASE = "https://api.openai.com/v1/chat/completions";

export async function generateOpenAiContent({
  apiKey,
  model,
  messages,
  temperature = 0.8,
  expectJson = false,
}) {
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  if (!model) {
    throw new Error("Missing OpenAI model name.");
  }

  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const body = {
    model,
    messages: normalizedMessages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
      content: String(message.content ?? ""),
    })),
    temperature,
    ...(expectJson ? { response_format: { type: "json_object" } } : {}),
  };

  const response = await fetch(OPENAI_CHAT_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await readOpenAiError(response);
    throw new Error(`OpenAI API error ${response.status}: ${detail}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content?.trim?.() ?? "";
  if (!text) {
    throw new Error("OpenAI returned an empty response.");
  }

  return text;
}

async function readOpenAiError(response) {
  let detail = response.statusText;
  try {
    const body = await response.json();
    detail =
      body?.error?.message ??
      body?.error?.type ??
      body?.message ??
      detail;
  } catch {
    // ignore
  }
  return detail;
}
