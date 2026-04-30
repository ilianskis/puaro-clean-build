const ELEVENLABS_SCRIBE_TOKEN_URL =
  "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";

export async function mintScribeToken(apiKey) {
  if (!apiKey) {
    throw new Error("Missing ELEVENLABS_API_KEY.");
  }

  const response = await fetch(ELEVENLABS_SCRIBE_TOKEN_URL, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
    },
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `Failed to create ElevenLabs realtime Scribe token (${response.status}): ${detail}`,
    );
  }

  const data = await response.json();
  if (!data?.token) {
    throw new Error("ElevenLabs did not return a realtime Scribe token.");
  }

  return data.token;
}

async function readErrorDetail(response) {
  let detail = response.statusText;
  try {
    const body = await response.json();
    detail = body?.detail?.message ?? body?.detail ?? body?.error ?? detail;
  } catch {
    // ignore parse errors
  }
  return detail;
}
