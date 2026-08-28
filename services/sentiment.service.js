const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Try newer model first — most widely available
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const VALID_CATEGORIES = new Set([
  "positive", "critical", "questions", "suggestions",
  "urgent", "business", "spam", "sarcasm", "neutral"
]);

// ── KEYWORD FALLBACK CLASSIFIER ────────────────────────────────────────
// Runs when Gemini fails OR returns "neutral" — handles Urdu + English
function keywordClassify(text) {
  const t = (text || "").toLowerCase();
  const orig = text || "";

  // QUESTIONS — English + Urdu patterns + ends with ?
  if (
    /\?/.test(t) ||
    /\b(how|what|when|where|why|which|who|can you|could you|please tell|please explain|please help|is it|is there|are there|do you|did you)\b/.test(t) ||
    /\b(bataen|batao|bata|kaise|kya|konsa|konsi|kaun|kahan|kab|kyun|kyunke|koi bata)\b/.test(t) ||
    /\b(mujhe batao|mujhe bataen|help me|tell me|guide me|suggest me)\b/.test(t)
  ) return "questions";

  // SPAM — self-promo, bots, links
  if (
    /\b(sub4sub|sub for sub|follow me|check out my channel|visit my|click here|click the link|free money|free iphone|giveaway|t\.me\/|wa\.me\/)\b/.test(t) ||
    /\b(sub|subscribe) (kar|karo|karna|krein|plz|please)\b/.test(t) ||
    /(http|www\.|\.com|\.ly|bit\.ly)/.test(t)
  ) return "spam";

  // BUSINESS — collab, sponsorship
  if (
    /\b(sponsor|collab|collaboration|business|partner|partnership|promotion|brand deal|contact me|email me|dm me|reach out)\b/.test(t) &&
    /\b(offer|inquiry|interested|discuss|opportunity|deal)\b/.test(t)
  ) return "business";

  // CRITICAL — complaints, bugs, problems
  if (
    /\b(problem|issue|bug|error|crash|not working|broken|fix this|worst|bad|terrible|hate|disappointed|useless|waste|doesn't work|nahi chal|kharab|bekar|galat)\b/.test(t)
  ) return "critical";

  // SUGGESTIONS — ideas, requests
  if (
    /\b(should add|please add|should make|should create|should improve|suggestion|feature request|would be better|next video|make a video|tutorial on|cover this topic|add this)\b/.test(t) ||
    /\b(chahiye|add karo|banana chahiye|improve karo)\b/.test(t)
  ) return "suggestions";

  // POSITIVE — praise, appreciation
  if (
    /\b(great|amazing|love|excellent|best|awesome|thank|thanks|wonderful|helpful|brilliant|perfect|nice|good job|well done|keep it up|outstanding|superb|fabulous)\b/.test(t) ||
    /\b(mashallah|masha allah|jazakallah|subhanallah|bahut acha|bohat acha|zabardast|behtareen|shukriya|shabaash)\b/.test(t) ||
    /[❤️🔥👏💯🙌😍🥰👍💪✨]/.test(orig)
  ) return "positive";

  // URGENT
  if (
    /\b(urgent|asap|immediately|right now|blocking|serious issue|emergency|please fix now|still not fixed)\b/.test(t)
  ) return "urgent";

  // SARCASM — common sarcastic patterns
  if (
    /\b(oh wow|sure buddy|yeah right|totally|obviously not|great job 🙄|nice try|cool story)\b/.test(t) ||
    /🙄|😒|😂.*obviously|lmao.*sure/.test(t)
  ) return "sarcasm";

  return "neutral";
}

// ── RETRY HELPER ───────────────────────────────────────────────────────
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

// ── MAIN CLASSIFIER ───────────────────────────────────────────────────
async function classifyComments(comments) {
  const BATCH_SIZE = 100;
  const batchPromises = [];

  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    batchPromises.push(classifyBatch(comments.slice(i, i + BATCH_SIZE)));
  }

  const batchResults = await Promise.all(batchPromises);
  const results = [];
  for (const r of batchResults) results.push(...r);
  return results;
}

async function classifyBatch(comments) {
  const input = comments
    .map((c, idx) => `${idx + 1}. [ID:${c.id}] ${c.body}`)
    .join("\n");

  const prompt = `You are a YouTube comment classifier. Classify each comment into EXACTLY ONE category:

- positive    → praise, appreciation, compliments, love, thanks, encouragement
- critical    → complaints, bugs, problems, negative feedback, disappointment  
- questions   → any question (ends with ?, asks how/what/why/when/where, seeks help or info)
- suggestions → feature requests, improvement ideas, "you should add/make/cover..."
- urgent      → time-sensitive errors, serious unresolved issues, blocking problems
- business    → sponsorship, collab offers, business inquiries, affiliate links
- spam        → repetitive spam, hate, self-promotion, irrelevant links, bots
- sarcasm     → irony, mocking, passive-aggressive, sarcastic tone
- neutral     → general comments, reactions, off-topic (use this ONLY if nothing else fits)

NOTE: Comments in Urdu, Hindi, or mixed languages must also be classified.
"How to withdraw money?" = questions
"Bahut acha video" = positive  
"Bhai problem hai" = critical
"Mujhe batao kaise karna hai?" = questions

COMMENTS:
${input}

RESPOND WITH ONLY valid JSON — no explanation, no markdown:
[{"id":"COMMENT_ID","category":"category_name"},...]`;

  let geminiResults = null;

  try {
    const result = await withRetry(() => model.generateContent(prompt));
    const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    geminiResults = parsed.map((item) => ({
      id: item.id,
      category:
        typeof item.category === "string" && VALID_CATEGORIES.has(item.category.trim().toLowerCase())
          ? item.category.trim().toLowerCase()
          : null, // null = let keyword fallback handle it
    }));
  } catch (err) {
    console.error("Gemini classification failed:", err.message);
    // Full keyword fallback if Gemini fails completely
    return comments.map((c) => ({
      id: c.id,
      category: keywordClassify(c.body),
    }));
  }

  // Build ID → body map for keyword fallback
  const bodyMap = new Map(comments.map((c) => [c.id, c.body]));

  // Hybrid: use Gemini result, but run keyword fallback for nulls OR "neutral"
  return geminiResults.map((item) => {
    const body = bodyMap.get(item.id) || "";
    if (!item.category || item.category === "neutral") {
      // Try keyword classifier — if it finds something specific, use it
      const kw = keywordClassify(body);
      return { id: item.id, category: kw };
    }
    return { id: item.id, category: item.category };
  });
}

// ── SENTIMENT SUMMARY ─────────────────────────────────────────────────
function buildSentimentSummary(comments) {
  const summary = {};
  for (const c of comments) {
    const cat = c.category || "neutral";
    summary[cat] = (summary[cat] || 0) + 1;
  }
  return summary;
}

// ── KEYWORD EXTRACTION ────────────────────────────────────────────────
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
    const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
    const keywords = JSON.parse(raw);
    return Array.isArray(keywords) ? keywords.slice(0, 8) : [];
  } catch {
    return [];
  }
}

// ── OVERALL COMMENT SUMMARY ───────────────────────────────────────────
// Reads through the comments and summarizes: what viewers like most,
// what they want / are asking for, and what to add in the next video.
async function generateOverallSummary(comments) {
  if (!comments || comments.length === 0) {
    return { viewers_like: "", viewers_want: "", video_suggestions: [] };
  }

  // Prioritize signal-rich categories, then fill with a general sample
  const priority = comments.filter((c) =>
    ["positive", "suggestions", "questions", "critical", "urgent", "business"].includes(c.category)
  );
  const rest = comments.filter((c) => !priority.includes(c));
  const sample = [...priority, ...rest].slice(0, 150).map((c) => c.body).join("\n");

  const prompt = `You are analyzing YouTube comments (English, Urdu, Hindi, or mixed) to help a creator understand their audience.

Read the comments below and summarize:
1. "viewers_like" — 2-3 sentences on what viewers like most about the video/channel (be specific: topics, style, moments — not generic praise).
2. "viewers_want" — 2-3 sentences on what viewers are asking for, requesting, or missing (recurring requests, unanswered questions, complaints).
3. "video_suggestions" — a list of 3-5 short, concrete, actionable ideas for what the creator should add or make in future videos, based directly on what these viewers said.

COMMENTS:
${sample}

RESPOND WITH ONLY valid JSON, no explanation, no markdown fences, in this exact shape:
{"viewers_like":"...","viewers_want":"...","video_suggestions":["...","...","..."]}`;

  try {
    const result = await withRetry(() => model.generateContent(prompt));
    const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    return {
      viewers_like: typeof parsed.viewers_like === "string" ? parsed.viewers_like : "",
      viewers_want: typeof parsed.viewers_want === "string" ? parsed.viewers_want : "",
      video_suggestions: Array.isArray(parsed.video_suggestions) ? parsed.video_suggestions.slice(0, 5) : [],
    };
  } catch (err) {
    console.error("Overall summary generation failed:", err.message);
    return { viewers_like: "", viewers_want: "", video_suggestions: [] };
  }
}

module.exports = { classifyComments, buildSentimentSummary, extractKeywords, generateOverallSummary };