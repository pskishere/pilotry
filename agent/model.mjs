import { createOpenAI } from "@ai-sdk/openai";
export const modelName = process.env.MAGPIE_MODEL || "zhipu/glm-5.3-flash";
export const provider = createOpenAI({
  baseURL: process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425/v1",
  apiKey: process.env.MAGPIE_TOKEN || "magpie",
  headers: {
    "x-openai-actor-authorization": process.env.MAGPIE_TOKEN || "magpie",
  },
});
