const Queue = require("better-queue");
const MemoryStore = require("better-queue-memory");
const { updateJob } = require("../db/jobStore");
const { fetchVideoMetadata, fetchComments } = require("../services/youtube.service");
const {
  classifyComments,
  buildSentimentSummary,
  extractKeywords,
} = require("../services/sentiment.service");

const analysisQueue = new Queue(
  async function (task, done) {
    const { jobId, videoId } = task;

    try {
      updateJob(jobId, {
        progress: { step: 1, label: "Fetching public video comments..." },
      });

      // Fetch metadata and comments in PARALLEL (faster!)
      let videoData, rawComments;
      try {
        [videoData, rawComments] = await Promise.all([
          fetchVideoMetadata(videoId),
          fetchComments(videoId, 150).catch((err) => {
            console.warn(`Comments unavailable for ${videoId}:`, err.message);
            return [];
          }),
        ]);
      } catch (err) {
        if (err.code === "VIDEO_NOT_FOUND") {
          updateJob(jobId, {
            status: "failed",
            error_code: "VIDEO_NOT_FOUND",
            message: "This video does not exist or has been removed.",
          });
          return done();
        }
        throw err;
      }

      updateJob(jobId, {
        progress: { step: 2, label: "Running NLP sentiment analysis..." },
      });

      let classifiedComments = rawComments;
      if (rawComments.length > 0) {
        const classifications = await classifyComments(rawComments);
        const categoryMap = new Map(classifications.map((c) => [c.id, c.category]));
        classifiedComments = rawComments.map((c) => ({
          ...c,
          category: categoryMap.get(c.id) || "neutral",
        }));
      }

      updateJob(jobId, {
        progress: {
          step: 3,
          label: "Extracting viewer questions & suggestions...",
        },
      });

      // Run sentiment summary + keyword extraction in PARALLEL (faster!)
      const [sentimentSummary, keywords] = await Promise.all([
        Promise.resolve(buildSentimentSummary(classifiedComments)),
        extractKeywords(classifiedComments),
      ]);

      updateJob(jobId, {
        progress: { step: 4, label: "Building interactive dashboard..." },
      });

      updateJob(jobId, {
        status: "complete",
        video: videoData,
        sentiment_summary: sentimentSummary,
        keywords,
        comments: classifiedComments,
      });

      done();
    } catch (err) {
      console.error(`Job ${jobId} failed:`, err.message);
      updateJob(jobId, {
        status: "failed",
        error_code: "INTERNAL_ERROR",
        message: "An unexpected error occurred. Please try again.",
      });
      done(err);
    }
  },
  {
    store: new MemoryStore(),
    concurrent: 3,   // Increased from 2 → handle more jobs at once
    maxRetries: 1,
    retryDelay: 1500,
  }
);

analysisQueue.on("task_failed", (taskId, err) => {
  console.error(`Task ${taskId} permanently failed:`, err?.message);
});

module.exports = analysisQueue;
