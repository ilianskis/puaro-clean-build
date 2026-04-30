import { defineConfig, loadEnv } from "vite";
import fs from "node:fs";
import path from "node:path";

import { mintScribeToken } from "./server/elevenlabs/scribeToken.js";
import { synthesizeElevenLabsSpeech } from "./server/elevenlabs/tts.js";
import { generateGeminiContent } from "./server/gemini/generateContent.js";
import { generateOpenAiContent } from "./server/openai/generateContent.js";

function elevenLabsScribeDevMiddleware(getApiKey) {
  return {
    name: "puaro-elevenlabs-scribe-token-dev-middleware",
    configureServer(server) {
      server.middlewares.use(
        "/api/elevenlabs/scribe-token",
        async (req, res, next) => {
          if (req.method !== "POST") {
            next();
            return;
          }

          try {
            const parsed = await readJsonBody(req);
            const apiKey = parsed?.customApiKey || getApiKey();
            if (!apiKey) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  error:
                    "Missing ELEVENLABS_API_KEY in local env. Set ELEVENLABS_API_KEY or enter your own ElevenLabs key.",
                }),
              );
              return;
            }

            const token = await mintScribeToken(apiKey);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ token }));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to mint realtime token.",
              }),
            );
          }
        },
      );
    },
  };
}

function geminiDevMiddleware(getApiKey) {
  return {
    name: "puaro-gemini-dev-middleware",
    configureServer(server) {
      server.middlewares.use(
        "/api/gemini/generate-content",
        async (req, res, next) => {
          if (req.method !== "POST") {
            next();
            return;
          }

          try {
            const parsed = await readJsonBody(req);
            const apiKey = parsed?.customApiKey || getApiKey();
            if (!apiKey) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  error:
                    "Missing GEMINI_API_KEY in local env. Gemini free tier still requires a Gemini API key from Google AI Studio.",
                }),
              );
              return;
            }

            const text = await generateGeminiContent({
              apiKey,
              model: parsed.model,
              messages: parsed.messages,
              temperature: parsed.temperature,
              expectJson: parsed.expectJson,
            });

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ text }));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error:
                  error instanceof Error
                    ? error.message
                    : "Gemini request failed.",
              }),
            );
          }
        },
      );
    },
  };
}

function elevenLabsTtsDevMiddleware(getApiKey) {
  return {
    name: "puaro-elevenlabs-tts-dev-middleware",
    configureServer(server) {
      server.middlewares.use(
        "/api/elevenlabs/tts",
        async (req, res, next) => {
          if (req.method !== "POST") {
            next();
            return;
          }

          try {
            const parsed = await readJsonBody(req);
            const apiKey = parsed?.customApiKey || getApiKey();
            if (!apiKey) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  error:
                    "Missing ELEVENLABS_API_KEY in local env. Set ELEVENLABS_API_KEY or enter your own ElevenLabs key.",
                }),
              );
              return;
            }

            const audioBuffer = await synthesizeElevenLabsSpeech({
              apiKey,
              voiceId: parsed?.voiceId,
              text: parsed?.text,
              voiceSettings: parsed?.voiceSettings,
            });

            res.statusCode = 200;
            res.setHeader("Content-Type", "audio/mpeg");
            res.setHeader("Cache-Control", "no-store");
            res.end(Buffer.from(audioBuffer));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to synthesize speech.",
              }),
            );
          }
        },
      );
    },
  };
}

function openAiDevMiddleware(getApiKey) {
  return {
    name: "puaro-openai-dev-middleware",
    configureServer(server) {
      server.middlewares.use(
        "/api/openai/generate-content",
        async (req, res, next) => {
          if (req.method !== "POST") {
            next();
            return;
          }

          try {
            const parsed = await readJsonBody(req);
            const apiKey = parsed?.customApiKey || getApiKey();
            if (!apiKey) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  error:
                    "Missing OPENAI_API_KEY in local env. Add OPENAI_API_KEY or enter your own OpenAI key.",
                }),
              );
              return;
            }

            const text = await generateOpenAiContent({
              apiKey,
              model: parsed.model,
              messages: parsed.messages,
              temperature: parsed.temperature,
              expectJson: parsed.expectJson,
            });

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ text }));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error:
                  error instanceof Error
                    ? error.message
                    : "OpenAI request failed.",
              }),
            );
          }
        },
      );
    },
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

function copyRuntimeAssetsPlugin() {
  return {
    name: "puaro-copy-runtime-assets",
    closeBundle() {
      const root = process.cwd();
      const runtimeDirs = ["buttons", "evidence", "faces", "sfx"];

      runtimeDirs.forEach((dirName) => {
        const sourceDir = path.resolve(root, "assets", dirName);
        const targetDir = path.resolve(root, "dist", "assets", dirName);
        if (!fs.existsSync(sourceDir)) return;
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        fs.cpSync(sourceDir, targetDir, { recursive: true });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const readEnv = () => loadEnv(mode, process.cwd(), "");
  const isTruthy = (value) =>
    ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
  const getElevenLabsApiKey = () => {
    const env = readEnv();
    return env.ELEVENLABS_API_KEY || env.VITE_ELEVENLABS_API_KEY || "";
  };
  const getGeminiApiKey = () => {
    const env = readEnv();
    return env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || "";
  };
  const getOpenAiApiKey = () => {
    const env = readEnv();
    return env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY || "";
  };
  const getDisableTrial = () => {
    const env = readEnv();
    return isTruthy(env.PUARO_DISABLE_TRIAL || env.VITE_PUARO_DISABLE_TRIAL);
  };

  return {
    plugins: [
      elevenLabsScribeDevMiddleware(getElevenLabsApiKey),
      elevenLabsTtsDevMiddleware(getElevenLabsApiKey),
      geminiDevMiddleware(getGeminiApiKey),
      openAiDevMiddleware(getOpenAiApiKey),
      copyRuntimeAssetsPlugin(),
    ],
    define: {
      __PUARO_DISABLE_TRIAL__: JSON.stringify(getDisableTrial()),
    },
    server: {
      port: 3000,
    },
    base: "./",
  };
});
