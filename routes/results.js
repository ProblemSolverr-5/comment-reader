const express = require("express");
const router = express.Router();
const { getJob } = require("../db/jobStore");

/**
 * GET /results/:jobId
 *
 * Returns the current state of an analysis job.
 * Frontend polls this every 1-2 seconds during the loading screen.
 *
 * Possible responses:
 *   status: "processing" → keep polling, includes current progress step
 *   status: "complete"   → full results ready to render
 *   status: "failed"     → show error view
 */
router.get('/', (req, res) => {
    res.send('Result route is working. Please provide a jobId to get specific results.');
});
router.get("/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json({
      error_code: "JOB_NOT_FOUND",
      message: "No analysis job found with that ID. It may have expired.",
    });
  }

  if (job.status === "processing") {
    return res.json({
      job_id: job.job_id,
      status: "processing",
      progress: job.progress,
    });
  }

  if (job.status === "failed") {
    return res.json({
      job_id: job.job_id,
      status: "failed",
      error_code: job.error_code,
      message: job.message,
    });
  }

  // Complete — return full payload
  return res.json({
    job_id: job.job_id,
    status: "complete",
    video: job.video,
    sentiment_summary: job.sentiment_summary,
    keywords: job.keywords,
    top_words: job.top_words,
    overall_summary: job.overall_summary,
    priority_replies: job.priority_replies,
    creator_brief: job.creator_brief,
    superfans: job.superfans,
    comments: job.comments,
  });
});

module.exports = router;
