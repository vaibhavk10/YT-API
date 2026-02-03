/**
 * YouTube Download API Server
 * Uses yt-dlp to download YouTube videos and audio
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const ytdlp = require('yt-dlp-exec');
const yts = require('yt-search');

const execAsync = promisify(exec);
const app = express();

// Configuration
const PORT = process.env.PORT || 3001; // Changed default to 3001 to avoid conflict
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const TEMP_DIR = path.join(__dirname, 'temp');
const API_NAME = process.env.API_NAME || 'YouTube Download API';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const FILE_CLEANUP_AGE = 30000; // 30 seconds in milliseconds (files deleted after 30 sec)
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

// Middleware
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(DOWNLOAD_DIR));

// Ensure directories exist
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Check for cookies file
if (fs.existsSync(COOKIES_PATH)) {
  const cookiesStats = fs.statSync(COOKIES_PATH);
  const cookiesSize = cookiesStats.size;
  if (cookiesSize > 0) {
    console.log(`✅ Cookies file found (${cookiesSize} bytes) - will be used for authentication`);
  } else {
    console.log('⚠️  Cookies file is empty - some videos may not be accessible');
  }
} else {
  console.log('⚠️  No cookies.txt found - some videos may not be accessible');
  console.log('💡 Tip: Export cookies from your browser and place them in the api/ folder');
}

/**
 * Clean up old files
 */
function cleanupOldFiles() {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const now = Date.now();
    
    files.forEach(file => {
      const filePath = path.join(DOWNLOAD_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > FILE_CLEANUP_AGE) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up old file: ${file}`);
        }
      } catch (err) {
        console.error(`Error cleaning up ${file}:`, err.message);
      }
    });
  } catch (err) {
    console.error('Error during cleanup:', err.message);
  }
}

// Run cleanup every 2 minutes to remove old files quickly
setInterval(cleanupOldFiles, 2 * 60 * 1000);

/**
 * Get video info using yt-search (primary) with yt-dlp fallback
 * yt-search is more reliable and doesn't have format checking issues
 */
async function getVideoInfo(url) {
  // Extract video ID from URL
  const videoIdMatch = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) {
    throw new Error('Invalid YouTube URL');
  }
  const videoId = videoIdMatch[1];

  // PRIMARY: Use yt-search (no format issues, more reliable)
  try {
    const search = await yts({ videoId });
    
    if (search && search.videos && search.videos.length > 0) {
      const video = search.videos[0];
      return {
        title: video.title || 'YouTube Video',
        duration: video.duration ? video.duration.seconds : 0,
        thumbnail: video.thumbnail || null,
        description: video.description || ''
      };
    }
  } catch (ytsError) {
    console.log('yt-search failed, trying yt-dlp fallback...', ytsError.message);
  }

  // FALLBACK: Use yt-dlp if yt-search fails (should rarely happen)
  try {
    const options = {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      skipDownload: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    };

    // Only use cookies if file exists and is not empty
    if (fs.existsSync(COOKIES_PATH)) {
      const cookiesStats = fs.statSync(COOKIES_PATH);
      if (cookiesStats.size > 0) {
        options.cookies = COOKIES_PATH;
      }
    }

    const info = await ytdlp(url, options);
    
    return {
      title: info.title || 'YouTube Video',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || null,
      description: info.description || ''
    };
  } catch (error) {
    console.error('Error getting video info with yt-dlp:', error);
    
    // If yt-dlp fails with format error, try yt-search again as last resort
    if (error.message && error.message.includes('Requested format is not available')) {
      try {
        console.log('Format error detected, retrying with yt-search...');
        const search = await yts({ videoId });
        
        if (search && search.videos && search.videos.length > 0) {
          const video = search.videos[0];
          return {
            title: video.title || 'YouTube Video',
            duration: video.duration ? video.duration.seconds : 0,
            thumbnail: video.thumbnail || null,
            description: video.description || ''
          };
        }
      } catch (fallbackError) {
        console.error('All methods failed:', fallbackError);
        throw new Error(`Failed to get video info: ${error.message}`);
      }
    }
    
    // Check for specific cookie-related errors
    if (error.message && (error.message.includes('Sign in to confirm') || error.message.includes('authentication'))) {
      throw new Error('YouTube authentication failed. Cookies may be expired or invalid. Please update cookies.txt with fresh cookies from your browser.');
    }
    
    throw new Error(`Failed to get video info: ${error.message}`);
  }
}

/**
 * Download YouTube audio
 */
app.get('/api/downloader/ytmp3', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({
        status: false,
        creator: API_NAME,
        error: 'URL parameter is required'
      });
    }

    // Validate YouTube URL
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      return res.status(400).json({
        status: false,
        creator: API_NAME,
        error: 'Invalid YouTube URL'
      });
    }

    // Get video info first
    let videoInfo;
    try {
      videoInfo = await getVideoInfo(url);
    } catch (infoError) {
      return res.status(500).json({
        status: false,
        creator: API_NAME,
        error: infoError.message
      });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `audio_${timestamp}.mp3`;
    const outputPath = path.join(DOWNLOAD_DIR, filename);

    // Download audio using yt-dlp
    const options = {
      output: outputPath,
      format: 'bestaudio/best',
      extractAudio: true,
      audioFormat: 'mp3',
      noPlaylist: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    };

    // Only use cookies if file exists and is not empty
    if (fs.existsSync(COOKIES_PATH)) {
      const cookiesStats = fs.statSync(COOKIES_PATH);
      if (cookiesStats.size > 0) {
        options.cookies = COOKIES_PATH;
      }
    }

    try {
      await ytdlp(url, options);
    } catch (downloadError) {
      console.error('Download error:', downloadError);
      
      // Check for cookie/authentication errors
      if (downloadError.message && (downloadError.message.includes('Sign in to confirm') || downloadError.message.includes('authentication'))) {
        return res.status(500).json({
          status: false,
          creator: API_NAME,
          error: 'YouTube authentication failed. Cookies may be expired or invalid. Please update cookies.txt with fresh cookies from your browser.'
        });
      }
      
      return res.status(500).json({
        status: false,
        creator: API_NAME,
        error: `Download failed: ${downloadError.message}`
      });
    }

    // Wait a moment for file system
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify file exists
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({
        status: false,
        creator: API_NAME,
        error: 'File not found after download'
      });
    }

    // Get file stats
    const stats = fs.statSync(outputPath);
    const fileSize = stats.size;

    // Construct download URL
    const downloadUrl = `${BASE_URL}/downloads/${filename}`;

    // Schedule file deletion after 30 seconds (enough time for download)
    setTimeout(() => {
      if (fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
          console.log(`✅ Cleaned up audio file: ${filename}`);
        } catch (err) {
          console.error(`❌ Error deleting ${filename}:`, err.message);
        }
      }
    }, FILE_CLEANUP_AGE);

    // Return Okatsu-style response
    res.json({
      status: true,
      creator: API_NAME,
      title: videoInfo.title,
      dl: downloadUrl,
      thumb: videoInfo.thumbnail,
      duration: videoInfo.duration,
      size: fileSize
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      status: false,
      creator: API_NAME,
      error: error.message || 'Internal server error'
    });
  }
});

/**
 * Download YouTube video
 */
app.get('/api/downloader/ytmp4', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({
        status: false,
        creator: API_NAME,
        error: 'URL parameter is required'
      });
    }

    // Validate YouTube URL
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      return res.status(400).json({
        status: false,
        creator: API_NAME,
        error: 'Invalid YouTube URL'
      });
    }

    // Get video info first
    let videoInfo;
    try {
      videoInfo = await getVideoInfo(url);
    } catch (infoError) {
      return res.status(500).json({
        status: false,
        creator: API_NAME,
        error: infoError.message
      });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `video_${timestamp}.mp4`;
    const outputPath = path.join(DOWNLOAD_DIR, filename);

    // Download video using yt-dlp
    const options = {
      output: outputPath,
      format: 'best[ext=mp4]/best',
      noPlaylist: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    };

    // Only use cookies if file exists and is not empty
    if (fs.existsSync(COOKIES_PATH)) {
      const cookiesStats = fs.statSync(COOKIES_PATH);
      if (cookiesStats.size > 0) {
        options.cookies = COOKIES_PATH;
      }
    }

    try {
      await ytdlp(url, options);
    } catch (downloadError) {
      console.error('Download error:', downloadError);
      
      // Check for cookie/authentication errors
      if (downloadError.message && (downloadError.message.includes('Sign in to confirm') || downloadError.message.includes('authentication'))) {
        return res.status(500).json({
          status: false,
          creator: API_NAME,
          error: 'YouTube authentication failed. Cookies may be expired or invalid. Please update cookies.txt with fresh cookies from your browser.'
        });
      }
      
      return res.status(500).json({
        status: false,
        creator: API_NAME,
        error: `Download failed: ${downloadError.message}`
      });
    }

    // Wait a moment for file system
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify file exists
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({
        status: false,
        creator: API_NAME,
        error: 'File not found after download'
      });
    }

    // Get file stats
    const stats = fs.statSync(outputPath);
    const fileSize = stats.size;

    // Construct download URL
    const downloadUrl = `${BASE_URL}/downloads/${filename}`;

    // Schedule file deletion after 30 seconds (enough time for download)
    setTimeout(() => {
      if (fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
          console.log(`✅ Cleaned up video file: ${filename}`);
        } catch (err) {
          console.error(`❌ Error deleting ${filename}:`, err.message);
        }
      }
    }, FILE_CLEANUP_AGE);

    // Return Okatsu-style response
    res.json({
      status: true,
      creator: API_NAME,
      title: videoInfo.title,
      dl: downloadUrl,
      thumb: videoInfo.thumbnail,
      duration: videoInfo.duration,
      size: fileSize
    });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      status: false,
      creator: API_NAME,
      error: error.message || 'Internal server error'
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: true,
    message: 'API is running',
    creator: API_NAME
  });
});

/**
 * Root endpoint
 */
app.get('/', (req, res) => {
  res.json({
    status: true,
    creator: API_NAME,
    message: 'YouTube Download API',
    endpoints: {
      audio: '/api/downloader/ytmp3?url=https://youtu.be/LZY0-ccz2-w?si=_hGGb5SmMwLL8UHbL',
      video: '/api/downloader/ytmp4?url=YOUTUBE_URL',
      health: '/health'
    }
  });
});

// Start server with error handling
const server = app.listen(PORT, () => {
  console.log(`🚀 ${API_NAME} running on port ${PORT}`);
  console.log(`📡 Base URL: ${BASE_URL}`);
  console.log(`📁 Downloads directory: ${DOWNLOAD_DIR}`);
  console.log(`\nEndpoints:`);
  console.log(`  Audio: GET ${BASE_URL}/api/downloader/ytmp3?url=https://youtu.be/LZY0-ccz2-w?si=_hGGb5SmMwLL8UHb`);
  console.log(`  Video: GET ${BASE_URL}/api/downloader/ytmp4?url=YOUTUBE_URL`);
  console.log(`  Health: GET ${BASE_URL}/health\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use.`);
    console.log(`💡 Try one of these solutions:`);
    console.log(`   1. Stop the process using port ${PORT}`);
    console.log(`   2. Change PORT in .env file to a different port (e.g., 3001)`);
    console.log(`   3. Find and kill the process: netstat -ano | findstr :${PORT}`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  cleanupOldFiles();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  cleanupOldFiles();
  process.exit(0);
});

