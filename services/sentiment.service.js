const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Baaki functions (summary, keywords, reply) ke liye
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Sirf classification ke liye: temperature 0 + strict JSON schema
const classifierModel = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  generationConfig: {
    temperature: 0,
    responseMimeType: "application/json",
    responseSchema: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          id: { type: SchemaType.STRING },
          category: {
            type: SchemaType.STRING,
            format: "enum",
            enum: ["positive", "critical", "questions", "suggestions", "urgent", "business", "spam", "sarcasm", "neutral"],
          },
        },
        required: ["id", "category"],
      },
    },
  },
});

const VALID_CATEGORIES = new Set([
  "positive", "critical", "questions", "suggestions",
  "urgent", "business", "spam", "sarcasm", "neutral"
]);

// ── KEYWORD FALLBACK CLASSIFIER ────────────────────────────────────────
// Sirf tab chalta hai jab Gemini fail ho ya kisi comment ki category na de.
// Gemini ke "neutral" ko kabhi override nahi karta.
function keywordClassify(text) {
  const t = (text || "").toLowerCase();
  const orig = text || "";

  // QUESTIONS
  if (
    /\?/.test(t) ||
    /\b(how|what|when|where|why|which|who|can you|could you|please tell|please explain|please help|is it|is there|are there|do you|did you)\b/.test(t) ||
    /\b(bataen|batao|bata|kaise|kya|konsa|konsi|kaun|kahan|kab|kyun|kyunke|koi bata)\b/.test(t) ||
    /\b(mujhe batao|mujhe bataen|help me|tell me|guide me|suggest me)\b/.test(t)
  ) return "questions";

  // SPAM
  if (
    /\b(sub4sub|sub for sub|follow me|check out my channel|visit my|click here|click the link|free money|free iphone|giveaway|t\.me\/|wa\.me\/)\b/.test(t) ||
    /\b(sub|subscribe) (kar|karo|karna|krein|plz|please)\b/.test(t) ||
    /(http|www\.|\.com|\.ly|bit\.ly)/.test(t)
  ) return "spam";

  // BUSINESS
  if (
    /\b(sponsor|collab|collaboration|business|partner|partnership|promotion|brand deal|contact me|email me|dm me|reach out)\b/.test(t) &&
    /\b(offer|inquiry|interested|discuss|opportunity|deal)\b/.test(t)
  ) return "business";

  const hasPositive =
    /\b(great|amazing|love|excellent|best|awesome|thank|thanks|wonderful|helpful|brilliant|perfect|nice|good job|well done|keep it up|outstanding|superb|fabulous)\b/.test(t) ||
    /\b(mashallah|masha allah|jazakallah|subhanallah|bahut acha|bohat acha|zabardast|behtareen|shukriya|shabaash)\b/.test(t) ||
    /[❤🔥👏💯🙌😍🥰👍💪✨]/.test(orig);

  // URGENT
  if (
    /\b(urgent|asap|immediately|right now|blocking|serious issue|emergency|please fix now|still not fixed)\b/.test(t)
  ) return "urgent";

  // CRITICAL: sirf jab positive signal na ho
  if (
    !hasPositive &&
    /\b(problem|issue|bug|error|crash|not working|broken|fix this|worst|terrible|hate|disappointed|doesn't work|nahi chal|kharab|bekar|galat)\b/.test(t)
  ) return "critical";

  // SUGGESTIONS
  if (
    /\b(should add|please add|should make|should create|should improve|suggestion|feature request|would be better|next video|make a video|tutorial on|cover this topic|add this)\b/.test(t) ||
    /\b(chahiye|add karo|banana chahiye|improve karo)\b/.test(t)
  ) return "suggestions";

  if (hasPositive) return "positive";

  // SARCASM
  if (
    /\b(oh wow|sure buddy|yeah right|obviously not|nice try|cool story)\b/.test(t) ||
    /🙄|😒/.test(t)
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
  const BATCH_SIZE = 40;
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

- positive    → praise, thanks, appreciation, encouragement, AND personal stories where the viewer says the video helped/inspired/changed them
- critical    → criticism aimed AT the video, creator, or guest (wrong info, boring, clickbait, bugs, disappointment with the content)
- questions   → any question (ends with ?, asks how/what/why/when/where, seeks help or info)
- suggestions → feature requests, improvement ideas, "you should add/make/cover..."
- urgent      → time-sensitive errors, serious unresolved issues, blocking problems
- business    → sponsorship, collab offers, business inquiries, affiliate links
- spam        → repetitive spam, hate, self-promotion, irrelevant links, bots
- sarcasm     → irony, mocking, passive-aggressive, sarcastic tone
- neutral     → general comments, reactions, off-topic (use ONLY if nothing else fits)

IMPORTANT RULES:
- Judge the viewer's attitude toward the VIDEO, not individual words.
- Negative words about the viewer's OWN life or habits ("I wasted my time", "distracted mind", "bad habits") are NOT criticism. If the viewer praises or thanks the video, it is "positive".
- Use "critical" ONLY when the viewer is actually criticizing the video/creator.
- If unsure between positive and critical, choose "neutral".
- Comments in Urdu, Hindi, Roman Urdu or mixed languages must also be classified.
- Return one result for EVERY comment, using the exact ID given.

Examples:
"I wish I saw this 5 years back, it would have saved my time. Amazing podcast" = positive
"A distracted mind can waste even a high IQ" = positive
"I will watch this brilliant episode whenever I feel tempted to waste time" = positive
"Thanks Raj, we want more guests like her" = positive
"This is clickbait, guest knows nothing" = critical
"How to withdraw money?" = questions
"Bahut acha video" = positive
"Bhai problem hai" = critical
"Mujhe batao kaise karna hai?" = questions

COMMENTS:
${input}

Return a JSON array: [{"id":"COMMENT_ID","category":"category_name"}, ...]`;

  let geminiResults = [];

  try {
    const result = await withRetry(() => classifierModel.generateContent(prompt));
    const raw = result.response.text().trim();
    const parsed = JSON.parse(raw);

    geminiResults = parsed.map((item) => ({
      id: String(item.id),
      category:
        typeof item.category === "string" && VALID_CATEGORIES.has(item.category.trim().toLowerCase())
          ? item.category.trim().toLowerCase()
          : null,
    }));
  } catch (err) {
    console.error("Gemini classification failed:", err.message);
    return comments.map((c) => ({ id: c.id, category: keywordClassify(c.body) }));
  }

  const bodyMap = new Map(comments.map((c) => [String(c.id), c.body]));

  // Gemini ka result rakho, neutral ko bhi override mat karo
  const finalResults = geminiResults
    .filter((item) => bodyMap.has(item.id))
    .map((item) => ({
      id: item.id,
      category: item.category || keywordClassify(bodyMap.get(item.id) || ""),
    }));

  // Jo comments Gemini ne skip kiye unhe fallback se fill karo
  const done = new Set(finalResults.map((r) => r.id));
  for (const c of comments) {
    if (!done.has(String(c.id))) {
      finalResults.push({ id: c.id, category: keywordClassify(c.body) });
    }
  }

  return finalResults;
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
async function generateOverallSummary(comments) {
  if (!comments || comments.length === 0) {
    return { viewers_like: "", viewers_want: "", video_suggestions: [] };
  }

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

// ── SMART COMMENT FILTERING (PRIORITY REPLY PICKER) ─────────────────────
async function identifyPriorityReplies(comments) {
  if (!comments || comments.length === 0) return [];

  const candidates = comments.filter((c) =>
    ["critical", "urgent", "business", "questions", "suggestions", "positive"].includes(c.category)
  );
  if (candidates.length === 0) return [];

  const categoryWeight = { urgent: 5, critical: 4, business: 4, questions: 3, suggestions: 3, positive: 1 };
  const shortlist = [...candidates]
    .sort((a, b) => (categoryWeight[b.category] + (b.likes || 0) / 50) - (categoryWeight[a.category] + (a.likes || 0) / 50))
    .slice(0, 40);

  const input = shortlist
    .map((c) => `[ID:${c.id}] (${c.category}, ${c.likes || 0} likes) ${c.body}`)
    .join("\n");

  const prompt = `You are helping a YouTube creator triage comments. From the list below, pick the 2 to 3 comments that MOST deserve a thoughtful, personal "genius" reply from the creator — the ones that are emotionally significant, high-stakes, high-value (a real problem, a business opportunity, a superfan going out of their way, a widely-shared question), or otherwise worth the creator's time. Ignore low-intent noise, generic praise, and anything that doesn't need a real response.

COMMENTS:
${input}

RESPOND WITH ONLY valid JSON — no explanation, no markdown fences — an array of 2 to 3 items, most important first:
[{"id":"COMMENT_ID","reason":"one short sentence on why this deserves a reply"}]`;

  try {
    const result = await withRetry(() => model.generateContent(prompt), 2, 700);
    const raw = result.response.text().trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");

    const bodyMap = new Map(comments.map((c) => [c.id, c]));
    return parsed
      .filter((item) => item && bodyMap.has(item.id))
      .slice(0, 3)
      .map((item) => ({
        ...bodyMap.get(item.id),
        priority_reason: typeof item.reason === "string" ? item.reason : "High-value comment worth a personal reply.",
      }));
  } catch (err) {
    console.error("Priority reply detection failed, using heuristic fallback:", err.message);
    return shortlist.slice(0, 3).map((c) => ({
      ...c,
      priority_reason:
        c.category === "urgent" ? "Time-sensitive issue that needs acknowledgement." :
        c.category === "critical" ? "A real complaint worth addressing directly." :
        c.category === "business" ? "Looks like a business or collab opportunity." :
        c.category === "questions" ? "A question likely shared by other viewers." :
        "Stood out for its engagement and specificity.",
    }));
  }
}

// ── PSYCHOLOGICALLY SUPPORTIVE CREATOR BRIEF ─────────────────────────────
async function generateCreatorBrief(comments) {
  if (!comments || comments.length === 0) {
    return "";
  }

  const sample = comments.slice(0, 120).map((c) => `(${c.category}) ${c.body}`).join("\n");

  const prompt = `You are writing a short, warm note directly to a YouTube creator, based on their video's comments below. Your job is NOT strategy advice — it's emotional grounding. In 2 to 3 sentences, tell them honestly how their community is actually feeling right now, and validate what's going well, in a calm, genuine, non-cheesy tone. If there's real criticism in the comments, acknowledge it honestly but gently — don't hide it, but don't catastrophize it either.

COMMENTS:
${sample}

RESPOND WITH ONLY the 2-3 sentence note as plain text. No markdown, no labels, no quotation marks.`;

  try {
    const result = await withRetry(() => model.generateContent(prompt), 2, 700);
    return result.response.text().trim().replace(/^["']|["']$/g, "");
  } catch (err) {
    console.error("Creator brief generation failed:", err.message);
    return "";
  }
}

// ── SUPERFAN / ACTIVE COMMENTER TRACKING ─────────────────────────────────
function computeSuperfans(comments, limit = 8) {
  if (!comments || comments.length === 0) return [];

  const map = new Map();
  for (const c of comments) {
    const user = c.user || "Unknown";
    if (!map.has(user)) {
      map.set(user, { user, avatar_url: c.avatar_url || null, comment_count: 0, total_likes: 0, positive_count: 0, spam_count: 0 });
    }
    const s = map.get(user);
    s.comment_count += 1;
    s.total_likes += c.likes || 0;
    if (c.category === "positive") s.positive_count += 1;
    if (c.category === "spam") s.spam_count += 1;
  }

  return Array.from(map.values())
    .filter((s) => s.comment_count >= 2 && s.spam_count === 0)
    .sort((a, b) => (b.comment_count * 3 + b.total_likes) - (a.comment_count * 3 + a.total_likes))
    .slice(0, limit);
}

module.exports = {
  classifyComments,
  buildSentimentSummary,
  extractKeywords,
  extractTopWords,
  generateOverallSummary,
  generateCommentReply,
  identifyPriorityReplies,
  generateCreatorBrief,
  computeSuperfans,
};