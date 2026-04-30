import { defineConfig, loadEnv } from "vite";

import { mintScribeToken } from "./server/elevenlabs/scribeToken.js";
import { generateGeminiContent } from "./server/gemini/generateContent.js";

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

          const apiKey = getApiKey();
          if (!apiKey) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error:
                  "Missing ELEVENLABS_API_KEY in local env. Set ELEVENLABS_API_KEY or VITE_ELEVENLABS_API_KEY.",
              }),
            );
            return;
          }

          try {
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

          const apiKey = getApiKey();
          if (!apiKey) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error:
                  "Missing GEMINI_API_KEY in local env. Set GEMINI_API_KEY before using Gemini.",
              }),
            );
            return;
          }

          try {
            const chunks = [];
            for await (const chunk of req) {
              chunks.push(Buffer.from(chunk));
            }
            const rawBody = Buffer.concat(chunks).toString("utf8");
            const parsed = rawBody ? JSON.parse(rawBody) : {};

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

export default defineConfig(({ mode }) => {
  const readEnv = () => loadEnv(mode, process.cwd(), "");
  const getElevenLabsApiKey = () => {
    const env = readEnv();
    return env.ELEVENLABS_API_KEY || env.VITE_ELEVENLABS_API_KEY || "";
  };
  const getGeminiApiKey = () => {
    const env = readEnv();
    return env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || "";
  };

  return {
    plugins: [
      elevenLabsScribeDevMiddleware(getElevenLabsApiKey),
      geminiDevMiddleware(getGeminiApiKey),
    ],
    server: {
      port: 3000,
    },
    base: "./",
  };
});
