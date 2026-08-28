const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { extractVideoId } = require("../services/youtube.service");
const { createJob } = require("../db/jobStore");
const analysisQueue = require("../workers/analysisQueue");

router.post("/", async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== "string" || !url.trim()) {
    return res.status(400).json({
      error_code: "INVALID_URL",
      message: "Please provide a YouTube video URL.",
    });
  }

  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  if (!isYouTube) {
    return res.status(400).json({
      error_code: "INVALID_URL",
      message: "The URL provided is not a valid YouTube video link.",
    });
  }

  const videoId = extractVideoId(url.trim());
  if (!videoId) {
    return res.status(400).json({
      error_code: "INVALID_URL",
      message: "Could not extract a video ID from this URL. Check the link and try again.",
    });
  }

  const jobId = `job_${uuidv4().replace(/-/g, "").slice(0, 12)}`;
  createJob(jobId, url.trim());
  analysisQueue.push({ jobId, videoId });

  return res.status(202).json({
    job_id: jobId,
    status: "processing",
    estimated_seconds: 10,
  });
});

module.exports = router;
