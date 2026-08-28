const axios = require("axios");

const YT_BASE = "https://www.googleapis.com/youtube/v3";
const API_KEY = process.env.YOUTUBE_API_KEY;

/**
 * Extract the video ID from any YouTube URL format:
 *   https://www.youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID
 *   https://www.youtube.com/shorts/VIDEO_ID
 */
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetch video metadata: title, channel, views, likes, comment count, thumbnail.
 */
async function fetchVideoMetadata(videoId) {
  const res = await axios.get(`${YT_BASE}/videos`, {
    params: {
      part: "snippet,statistics",
      id: videoId,
      key: API_KEY,
    },
  });

  const items = res.data.items;
  if (!items || items.length === 0) {
    const error = new Error("Video not found");
    error.code = "VIDEO_NOT_FOUND";
    throw error;
  }

  const item = items[0];
  const stats = item.statistics;
  const snippet = item.snippet;

  const views = parseInt(stats.viewCount || "0", 10);
  const likes = parseInt(stats.likeCount || "0", 10);
  const commentCount = parseInt(stats.commentCount || "0", 10);

  // Engagement ratio: (likes + comments) / views * 100, capped at 100
  const engagementRatio =
    views > 0 ? Math.min(((likes + commentCount) / views) * 100, 100) : 0;

  return {
    id: videoId,
    title: snippet.title,
    channel: snippet.channelTitle,
    channel_id: snippet.channelId || null,
    thumbnail_url:
      snippet.thumbnails?.high?.url ||
      snippet.thumbnails?.default?.url ||
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    published_at: snippet.publishedAt,
    views,
    likes,
    comment_count: commentCount,
    engagement_ratio: Math.round(engagementRatio * 10) / 10,
    growth_percent: null, // Requires historical data; left for future enhancement
  };
}

/**
 * Fetch up to maxComments top-level comments (max 1000).
 * YouTube API returns 100 per page; we page through up to 10 times.
 */
async function fetchComments(videoId, maxComments = 300) {
  const comments = [];
  let pageToken = null;
  const maxPages = Math.ceil(Math.min(maxComments, 1000) / 100);

  for (let page = 0; page < maxPages; page++) {
    const params = {
      part: "snippet",
      videoId,
      maxResults: 100,
      order: "relevance", // top comments first
      key: API_KEY,
    };
    if (pageToken) params.pageToken = pageToken;

    let res;
    try {
      res = await axios.get(`${YT_BASE}/commentThreads`, { params });
    } catch (err) {
      // Comments may be disabled
      if (err.response?.status === 403) break;
      throw err;
    }

    for (const item of res.data.items || []) {
      const top = item.snippet.topLevelComment.snippet;
      comments.push({
        id: item.id,
        user: top.authorDisplayName,
        author_channel_id: top.authorChannelId?.value || null,
        avatar_url: top.authorProfileImageUrl || null,
        published_at: top.publishedAt,
        time_ago: timeAgo(new Date(top.publishedAt)),
        body: top.textDisplay
          // Strip basic HTML tags YouTube sometimes includes
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]+>/g, ""),
        likes: top.likeCount || 0,
        reply_count: item.snippet.totalReplyCount || 0,
        category: null, // Filled in by AI service
      });

      if (comments.length >= maxComments) break;
    }

    pageToken = res.data.nextPageToken;
    if (!pageToken || comments.length >= maxComments) break;
  }

  return comments;
}

/** Human-readable "X hours ago" string */
function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

module.exports = { extractVideoId, fetchVideoMetadata, fetchComments };
