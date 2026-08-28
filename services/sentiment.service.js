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

// ── TOP MEANINGFUL WORDS / TOPICS ──────────────────────────────────────
// Finds words/phrases that actually carry meaning and repeat across
// comments — specific names, places, products, topics, recurring
// requests — NOT filler words like "i", "hai", "very", "good", etc.
async function extractTopWords(comments) {
  if (!comments || comments.length === 0) return [];

  const sample = comments.slice(0, 150).map((c) => c.body).join("\n");

  const prompt = `You are analyzing YouTube comments (English, Urdu, Hindi, or mixed) to find what viewers keep talking about.

Find words or short phrases that are MEANINGFUL and REPEAT across multiple comments — for example: a specific place name, a person's name, a product/topic/feature name, a recurring request, or a specific thing mentioned again and again.

STRICTLY EXCLUDE:
- Generic filler words (i, you, is, the, hai, ka, ki, aur, very, good, nice, etc.)
- Generic praise/reaction words with no specific meaning (great, love, amazing, acha, zabardast) unless they are part of a specific recurring phrase
- Anything that isn't actually repeated by multiple different comments

Only include a word/phrase if it is genuinely repeated and specific enough to tell the creator something useful about their audience.

COMMENTS:
${sample}

RESPOND WITH ONLY valid JSON — no explanation, no markdown — as an array sorted by how many times it's mentioned, most first, max 12 items:
[{"word":"short phrase or name","count":3}, ...]`;

  try {
    const result = await withRetry(() => model.generateContent(prompt));
    const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.word === "string" && item.word.trim())
      .map((item) => ({
        word: item.word.trim(),
        count: Number.isFinite(item.count) ? item.count : 1,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  } catch (err) {
    console.error("Top words extraction failed:", err.message);
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
3. "video_suggestion" — EXACTLY 2-3 sentences, no more. Speak directly to the creator using audience psychology: tell them what type of viewers they have based on these comments, and why making more videos like what these viewers are reacting to / asking for will increase attraction and engagement — because that is specifically what this audience wants and keeps coming back for. Be specific to these comments, not generic advice.

COMMENTS:
${sample}

RESPOND WITH ONLY valid JSON, no explanation, no markdown fences, in this exact shape:
{"viewers_like":"...","viewers_want":"...","video_suggestion":"..."}`;

  try {
    const result = await withRetry(() => model.generateContent(prompt));
    const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    return {
      viewers_like: typeof parsed.viewers_like === "string" ? parsed.viewers_like : "",
      viewers_want: typeof parsed.viewers_want === "string" ? parsed.viewers_want : "",
      video_suggestion: typeof parsed.video_suggestion === "string" ? parsed.video_suggestion : "",
    };
  } catch (err) {
    console.error("Overall summary generation failed:", err.message);
    return { viewers_like: "", viewers_want: "", video_suggestion: "" };
  }
}

// ── SINGLE COMMENT REPLY GENERATOR ──────────────────────────────────────
// Generates one professional, engaging reply for a specific comment so
// the creator can copy-paste it directly. Used by the "Generate Reply"
// button on individual comments (for standout/important comments, not
// meant to be run on all comments in bulk).
async function generateCommentReply(commentBody, options = {}) {
  const { channelTone = "friendly and professional" } = options;
  const text = (commentBody || "").trim();
  if (!text) return "";

  const prompt = `You are a YouTube creator replying to one viewer comment. Write ONE reply to this comment.

Comment: "${text}"

Rules:
- Tone: ${channelTone}, warm, genuine — not robotic or generic.
- Keep it short: 1-3 sentences.
- If the comment asks a question, acknowledge it and give a helpful, encouraging response (without inventing facts you can't know).
- If it's praise, thank them specifically for what they mentioned, not generically.
- If it's a complaint/bug, acknowledge it, show you care, and reassure without over-promising.
- Match the comment's language (reply in Urdu/Hindi/Roman Urdu if the comment is in that language; English if it's in English).
- Do NOT use quotation marks around the reply, no markdown, no explanation — output ONLY the reply text itself.`;

  try {
    const result = await withRetry(() => model.generateContent(prompt), 2, 600);
    return result.response.text().trim().replace(/^["']|["']$/g, "");
  } catch (err) {
    console.error("Reply generation failed:", err.message);
    return "";
  }
}

module.exports = {
  classifyComments,
  buildSentimentSummary,
  extractKeywords,
  extractTopWords,
  generateOverallSummary,
  generateCommentReply,
};
