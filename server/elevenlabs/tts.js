const ELEVENLABS_TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_MODEL = "eleven_turbo_v2_5";

export async function synthesizeElevenLabsSpeech({
  apiKey,
  voiceId,
  text,
  voiceSettings,
}) {
  if (!apiKey) {
    throw new Error("Missing ELEVENLABS_API_KEY.");
  }

  if (!voiceId) {
    throw new Error("Missing ElevenLabs voice ID.");
  }

  const response = await fetch(
    `${ELEVENLABS_TTS_BASE}/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: String(text ?? "").trim(),
        model_id: ELEVENLABS_MODEL,
        voice_settings: voiceSettings,
      }),
    },
  );

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`ElevenLabs TTS error ${response.status}: ${detail}`);
  }

  return response.arrayBuffer();
}

async function readErrorDetail(response) {
  let detail = response.statusText;
  try {
    const body = await response.json();
    detail = body?.detail?.message ?? body?.detail ?? body?.error ?? detail;
  } catch {
    // ignore
  }
  return detail;
}
