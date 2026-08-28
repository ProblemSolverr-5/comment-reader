const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use correct, fast model
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Retry helper — exponential backoff
async function withRetry(fn, retries = 3, delayMs = 800) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      console.warn(`Attempt ${attempt} failed: ${err.message}${isLast ? " — giving up." : " — retrying..."}`);
      if (isLast) throw err;
      await new Promise((res) => setTimeout(res, delayMs * attempt));
    }
  }
}

/**
 * FIXED: Classify comments into FIXED categories that match the frontend filters.
 * Categories: positive, critical, questions, suggestions, urgent, business, spam, sarcasm, neutral
 */
async function classifyComments(comments) {
  const results = [];
  const BATCH_SIZE = 100; // Increased from 50 → fewer Gemini calls = faster

  // Process all batches — collect promises for parallel execution
  const batchPromises = [];
  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    const batch = comments.slice(i, i + BATCH_SIZE);
    batchPromises.push(classifyBatch(batch));
  }

  // Run batches concurrently (faster than sequential)
  const batchResults = await Promise.all(batchPromises);
  for (const r of batchResults) results.push(...r);

  return results;
}

async function classifyBatch(comments) {
  const input = comments
    .map((c, idx) => `${idx + 1}. [ID:${c.id}] ${c.body}`)
    .join("\n");

  // FIXED PROMPT: Force Gemini to use exact category names matching frontend filters
  const prompt = `You are a YouTube comment classifier. Assign each comment to EXACTLY ONE category from this fixed list:

- positive    → praise, appreciation, compliments, encouragement, love, support
- critical    → complaints, bugs, problems, negative feedback, disappointment, criticism
- questions   → asking something, seeking help, seeking clarification, confused viewer
- suggestions → feature requests, improvement ideas, recommendations, "you should add..."
- urgent      → time-sensitive errors blocking users, serious unresolved issues, repeated crashes
- business    → sponsorship offers, collaboration requests, business inquiries, affiliate links
- spam        → repetitive spam, hate speech, offensive content, irrelevant self-promotion, bots
- sarcasm     → irony, mocking, sarcastic tone, passive-aggressive comments
- neutral     → general reactions, off-topic, does not fit any above category

COMMENTS:
${input}

RESPOND WITH ONLY valid JSON array — no explanation, no markdown fences, no extra text:
[{"id":"COMMENT_ID","category":"one_of_the_9_categories_above"},...]

Rules:
- Use ONLY these exact category names: positive, critical, questions, suggestions, urgent, business, spam, sarcasm, neutral
- Use exactly the IDs from the [ID:...] tags
- Every comment must get exactly one category`;

  try {
    const result = await withRetry(() => model.generateContent(prompt));
    const raw = result.response.text().trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    const VALID_CATEGORIES = new Set([
      "positive","critical","questions","suggestions",
      "urgent","business","spam","sarcasm","neutral"
    ]);

    return parsed.map((item) => ({
      id: item.id,
      category:
        typeof item.category === "string" && VALID_CATEGORIES.has(item.category.trim().toLowerCase())
          ? item.category.trim().toLowerCase()
          : "neutral",
    }));
  } catch (err) {
    console.error("Sentiment classification failed after retries:", err.message);
    return comments.map((c) => ({ id: c.id, category: "neutral" }));
  }
}

/**
 * Build sentiment summary counts.
 */
function buildSentimentSummary(comments) {
  const summary = {};
  for (const c of comments) {
    const cat = c.category || "neutral";
    summary[cat] = (summary[cat] || 0) + 1;
  }
  return summary;
}

/**
 * Extract top repeated keywords/themes using Gemini.
 */
async function extractKeywords(comments) {
  if (comments.length === 0) return [];

  const sample = comments
    .slice(0, 80)
    .map((c) => c.body)
    .join("\n");

  const prompt = `Extract the top 8 recurring topics or keywords from these YouTube comments.
Return ONLY a JSON array of short phrases (2-4 words each), no explanation, no markdown fences.
Example: ["react hooks","audio quality","part 2","VS Code theme"]

COMMENTS:
${sample}`;

  try {
    const result = await withRetry(() => model.generateContent(prompt));
    const raw = result.response
      .text()
      .trim()
      .replace(/```json|```/g, "")
      .trim();
    const keywords = JSON.parse(raw);
    return Array.isArray(keywords) ? keywords.slice(0, 8) : [];
  } catch {
    return [];
  }
}

module.exports = { classifyComments, buildSentimentSummary, extractKeywords };
