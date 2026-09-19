/**
 * translateClient.js
 * Wraps Gemini's text model to translate a customer's search query into
 * English. The storefront's product search (index.html's doSearch) is a
 * plain substring match against English product titles/categories/subs,
 * so a query typed in another language won't match anything on its own —
 * this is the fallback that lets it still find the right products.
 *
 * Reuses the same GEMINI_API_KEY secret as tryonClient.js — no extra
 * setup needed beyond what the AI try-on feature already requires.
 */

const axios = require("axios");

const MODEL = "gemini-2.5-flash";
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/**
 * Translates (or typo-corrects) a search query into English shopping
 * keywords. Returns the translated string, e.g. "सोने की चूड़ी" -> "gold bangle".
 */
async function translateToEnglish(apiKey, query) {
  const prompt = [
    "You are the search box translator for an online fashion/accessories store.",
    "The user typed a search query, possibly in a language other than English, possibly with typos or transliteration.",
    "Return ONLY the English translation of the shopping-relevant keywords — no explanation, no leading/trailing punctuation, no quotes.",
    "If it's already in English, just return it (typo-corrected if needed).",
    `Query: ${query}`,
  ].join(" ");

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 40 },
  };

  const res = await axios.post(BASE_URL, payload, {
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    timeout: 15000,
  });

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no translation.");
  return text.trim().replace(/^["']|["']$/g, "");
}

module.exports = { translateToEnglish };
