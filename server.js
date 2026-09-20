require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const rateLimiter = require("./middleware/rateLimiter");

const analyzeRouter = require("./routes/analyze");
const resultsRouter = require("./routes/results");
const commentsRouter = require("./routes/comments");

const app = express();
const PORT = process.env.PORT || 3001;
app.set('trust proxy', 1);

// ── Static Frontend ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "frontend")));


// ── CORS ─────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "https://commentreader.com",
  "https://www.commentreader.com",
  "https://comment-reader-production.up.railway.app"
];
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error("CORS: origin not allowed — " + origin));
    },
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ── Security & Parsing ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json());

// ── Rate Limiting ────────────────────────────────────────────────────
app.use(rateLimiter);

// ── API Routes ───────────────────────────────────────────────────────
app.use("/v1/analyze", analyzeRouter);
app.use("/v1/results", resultsRouter);
app.use("/v1/comments", commentsRouter);

// ── Health Check ─────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: {
      youtube_key: !!process.env.YOUTUBE_API_KEY,
      gemini_key: !!process.env.GEMINI_API_KEY,
    },
  });
});

// ── Serve Frontend ───────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

// ── 404 Handler ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error_code: "NOT_FOUND", message: "Route not found." });
});

// ── Global Error Handler ─────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error_code: "INTERNAL_ERROR",
    message: "An unexpected server error occurred.",
  });
});

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║   Comment Insights Pro — Backend       ║");
  console.log(`║   Running on http://localhost:${PORT}      ║`);
  console.log("╚════════════════════════════════════════╝\n");

  if (!process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY.startsWith("YOUR_")) {
    console.warn("⚠️  WARNING: YOUTUBE_API_KEY not set. YouTube calls will fail.");
  }
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.startsWith("YOUR_")) {
    console.warn("⚠️  WARNING: GEMINI_API_KEY not set. Sentiment analysis will fall back to 'neutral'.");
  }
});