/**
 * YouTube Download API Server
 * Uses yt-dlp to download YouTube videos and audio
 */

// Only load dotenv if not in Vercel (Vercel uses environment variables directly)
if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
  require('dotenv').config();
}
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const ytdlp = require('yt-dlp-exec');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');

const execAsync = promisify(exec);
const app = express();

// Configuration
const PORT = process.env.PORT || 3001; // Changed default to 3001 to avoid conflict
// Use /tmp for Vercel serverless, otherwise use local downloads directory
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV;
const DOWNLOAD_DIR = isVercel ? path.join('/tmp', 'downloads') : path.join(__dirname, 'downloads');
const TEMP_DIR = isVercel ? path.join('/tmp', 'temp') : path.join(__dirname, 'temp');
const API_NAME = process.env.API_NAME || 'YouTube Download API';
const CREATOR_NAME = process.env.CREATOR_NAME || API_NAME;
const API_KEY = process.env.API_KEY || process.env.APIKEY || null;
// Optional: use Cobalt to generate a remote tunnel download link (no server-side downloading)
const COBALT_URL = (process.env.COBALT_URL || '').replace(/\/+$/, '');
// Use Vercel's URL if available, otherwise use BASE_URL or localhost
const BASE_URL = process.env.VERCEL_URL 
  ? `https://${process.env.VERCEL_URL}` 
  : (process.env.BASE_URL || `http://localhost:${PORT}`);
const FILE_CLEANUP_AGE = 30000; // 30 seconds in milliseconds (files deleted after 30 sec)
const COOKIES_PATH = isVercel ? path.join('/tmp', 'cookies.txt') : path.join(__dirname, 'cookies.txt');

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Simple API key guard (query param: apikey)
 */
function requireApiKey(req, res) {
  // If no API_KEY is configured, allow all (backwards-compatible)
  if (!API_KEY) return true;

  const apikey = req.query.apikey;
  if (!apikey || apikey !== API_KEY) {
    res.status(401).json({
      status: 401,
      success: false,
      creator: CREATOR_NAME,
      error: 'Invalid API key'
    });
    return false;
  }

  return true;
}

function formatDurationTimestamp(totalSeconds) {
  const s = Number(totalSeconds) || 0;
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = Math.floor(s % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function requestCobaltDownload({ url, type, format, quality }) {
  if (!COBALT_URL) return null;

  // Cobalt instances commonly expose /api/json (cobalt.tools compatible)
  // We keep the payload flexible and accept multiple response shapes.
  const endpoint = `${COBALT_URL}/api/json`;
  const body = {
    url,
    // audio settings
    isAudioOnly: type === 'audio',
    aFormat: format || (type === 'audio' ? 'mp3' : undefined),
    // video settings (if needed later)
    vCodec: 'h264',
    vQuality: quality || '1080',
    filenameStyle: 'classic'
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = (data && (data.error || data.message)) ? (data.error || data.message) : `Cobalt error (${resp.status})`;
    throw new Error(msg);
  }

  // Accept common shapes:
  // - { status: 'stream', url: 'https://.../tunnel?...' }
  // - { status: 'redirect', url: 'https://...' }
  // - { url: 'https://...' }
  // - { download_url: 'https://...' }
  const downloadUrl = data?.url || data?.download_url || data?.result?.url || data?.result?.download_url;
  if (!downloadUrl) return null;

  return { raw: data, downloadUrl };
}

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Only serve static files if not in Vercel (Vercel handles static files differently)
if (!isVercel) {
  app.use('/downloads', express.static(DOWNLOAD_DIR));
}

/**
 * Direct download endpoint for audio and video files
 * Serves files with proper download headers
 */
app.get('/download/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(DOWNLOAD_DIR, filename);
    
    // Security: Only allow files from downloads directory
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        status: false,
        creator: API_NAME,
        error: 'File not found'
      });
    }
    
    // Set headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');
    
    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
    fileStream.on('error', (err) => {
      console.error('Error streaming file:', err);
      if (!res.headersSent) {
        res.status(500).json({
          status: false,
          creator: API_NAME,
          error: 'Error streaming file'
        });
      }
    });
  } catch (error) {
    console.error('Download endpoint error:', error);
    res.status(500).json({
      status: false,
      creator: API_NAME,
      error: error.message
    });
  }
});

// Ensure directories exist (safely handle for serverless)
try {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
} catch (err) {
  console.error('Error creating directories:', err.message);
}

// Check for cookies file (safely handle for serverless)
try {
  if (fs.existsSync(COOKIES_PATH)) {
    const cookiesStats = fs.statSync(COOKIES_PATH);
    const cookiesSize = cookiesStats.size;
    if (cookiesSize > 0) {
      console.log(`✅ Cookies file found (${cookiesSize} bytes) - will be used for authentication`);
    } else {
      console.log('⚠️  Cookies file is empty - some videos may not be accessible');
    }
  } else {
    if (!isVercel) {
      console.log('⚠️  No cookies.txt found - some videos may not be accessible');
      console.log('💡 Tip: Export cookies from your browser and place them in the api/ folder');
    }
  }
} catch (err) {
  console.log('⚠️  Could not check cookies file:', err.message);
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

// Run cleanup every 2 minutes to remove old files quickly (only in non-serverless)
if (!isVercel) {
  setInterval(cleanupOldFiles, 2 * 60 * 1000);
}

/**
 * Download audio using ytdl-core (pytubefix method)
 * Fallback when yt-dlp fails - works directly with YouTube API
 */
async function downloadAudioWithYtdlCore(url, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      console.log('Using ytdl-core (pytubefix method) to download audio...');
      
      // Get audio stream from YouTube (similar to pytubefix)
      const audioStream = ytdl(url, {
        quality: 'highestaudio',
        filter: 'audioonly'
      });

      // Pipe to file and convert to MP3 using ffmpeg
      ffmpeg(audioStream)
        .audioBitrate(320)
        .audioCodec('libmp3lame')
        .format('mp3')
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(new Error(`Audio conversion failed: ${err.message}`));
        })
        .on('end', () => {
          console.log('✅ Audio conversion completed with ytdl-core');
          resolve();
        })
        .save(outputPath);
    } catch (error) {
      reject(error);
    }
  });
}

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
    // Try with videoId first
    let search = await yts({ videoId });
    
    // If that doesn't work, try with full URL
    if (!search || !search.videos || search.videos.length === 0) {
      console.log('yt-search with videoId returned empty, trying with full URL...');
      search = await yts(url);
    }
    
    if (search && search.videos && search.videos.length > 0) {
      const video = search.videos[0];
      console.log('✅ Successfully got video info with yt-search');
      return {
        title: video.title || 'YouTube Video',
        duration: video.duration ? video.duration.seconds : 0,
        thumbnail: video.thumbnail || null,
        description: video.description || ''
      };
    } else {
      console.log('yt-search returned empty results, trying yt-dlp fallback...');
    }
  } catch (ytsError) {
    console.log('yt-search failed, trying yt-dlp fallback...', ytsError.message);
  }

  // FALLBACK: Use yt-dlp if yt-search fails (should rarely happen)
  try {
    console.log('Attempting to get video info with yt-dlp...');
    const options = {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      skipDownload: true,
      format: 'best',  // Prevent format errors when extracting metadata
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
    
    console.log('✅ Successfully got video info with yt-dlp');
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
        // Try both methods
        let search = await yts({ videoId });
        if (!search || !search.videos || search.videos.length === 0) {
          console.log('yt-search with videoId failed in fallback, trying with full URL...');
          search = await yts(url);
        }
        
        if (search && search.videos && search.videos.length > 0) {
          const video = search.videos[0];
          console.log('✅ Successfully got video info with yt-search fallback');
          return {
            title: video.title || 'YouTube Video',
            duration: video.duration ? video.duration.seconds : 0,
            thumbnail: video.thumbnail || null,
            description: video.description || ''
          };
        } else {
          console.error('yt-search fallback also returned empty results');
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

    // Download audio using yt-dlp with retry logic for different formats
    // Prioritize 128k audio formats
    const formatOptions = [
      'bestaudio[abr<=128]/bestaudio[abr<=128k]/bestaudio[ext=m4a][abr<=128]',
      'bestaudio[ext=m4a][abr<=128]/bestaudio[ext=webm][abr<=128]',
      'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
      'bestaudio/best',
      'best[ext=m4a]/best',
      'best'
    ];

    let downloadSuccess = false;
    let lastError = null;

    for (const formatOption of formatOptions) {
      try {
        console.log(`Attempting download with format: ${formatOption}`);
        const options = {
          output: outputPath,
          format: formatOption,
          extractAudio: true,
          audioFormat: 'mp3',
          audioQuality: '0',
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

        await ytdlp(url, options);
        downloadSuccess = true;
        console.log(`✅ Download successful with format: ${formatOption}`);
        break; // Success, exit loop
      } catch (formatError) {
        console.log(`Format "${formatOption}" failed, trying next...`);
        lastError = formatError;
        // Continue to next format
      }
    }

    if (!downloadSuccess) {
      // All yt-dlp formats failed, try ytdl-core fallback (similar to pytubefix)
      console.log('yt-dlp failed, trying ytdl-core fallback (pytubefix method)...');
      try {
        await downloadAudioWithYtdlCore(url, outputPath);
        downloadSuccess = true;
        console.log('✅ Download successful with ytdl-core fallback');
      } catch (ytdlError) {
        console.error('ytdl-core fallback also failed:', ytdlError);
        
        // Check for cookie/authentication errors
        if (lastError.message && (lastError.message.includes('Sign in to confirm') || lastError.message.includes('authentication'))) {
          return res.status(500).json({
            status: false,
            creator: API_NAME,
            error: 'YouTube authentication failed. Cookies may be expired or invalid. Please update cookies.txt with fresh cookies from your browser.'
          });
        }
        
        return res.status(500).json({
          status: false,
          creator: API_NAME,
          error: `Download failed: ${ytdlError.message || lastError.message}`
        });
      }
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

    // Construct direct download URL
    const downloadUrl = `${BASE_URL}/download/${filename}`;

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

    // Return response with direct downloadable MP3 link
    res.json({
      status: true,
      creator: API_NAME,
      title: videoInfo.title,
      dl: downloadUrl,  // Direct downloadable MP3 link
      thumb: videoInfo.thumbnail,
      duration: videoInfo.duration,
      size: fileSize,
      format: 'mp3'
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
 * PrinceTech-style endpoint (apikey + nested result + download_url)
 * GET /api/download/ytmp3?apikey=xxx&url=YOUTUBE_URL
 */
app.get('/api/download/ytmp3', async (req, res) => {
  try {
    if (!requireApiKey(req, res)) return;

    const { url } = req.query;
    if (!url) {
      return res.status(400).json({
        status: 400,
        success: false,
        creator: CREATOR_NAME,
        error: 'URL parameter is required'
      });
    }

    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      return res.status(400).json({
        status: 400,
        success: false,
        creator: CREATOR_NAME,
        error: 'Invalid YouTube URL'
      });
    }

    // Get info (title/thumb/duration)
    const videoInfo = await getVideoInfo(url);

    // Preferred: generate a remote tunnel URL via Cobalt (no server storage)
    let downloadUrl = null;
    try {
      const cobalt = await requestCobaltDownload({ url, type: 'audio', format: 'mp3' });
      if (cobalt?.downloadUrl) downloadUrl = cobalt.downloadUrl;
    } catch (cobaltErr) {
      console.log('Cobalt download failed, falling back to server-side download:', cobaltErr.message);
    }

    // Fallback: server-side download (existing behavior) if Cobalt isn't configured/failed
    if (!downloadUrl) {
      // Generate unique filename
      const timestamp = Date.now();
      const filename = `audio_${timestamp}.mp3`;
      const outputPath = path.join(DOWNLOAD_DIR, filename);

      // Try yt-dlp first (same retry list as existing endpoint)
      const formatOptions = [
        'bestaudio[abr<=128]/bestaudio[abr<=128k]/bestaudio[ext=m4a][abr<=128]',
        'bestaudio[ext=m4a][abr<=128]/bestaudio[ext=webm][abr<=128]',
        'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        'bestaudio/best',
        'best[ext=m4a]/best',
        'best'
      ];

      let downloadSuccess = false;
      let lastError = null;
      for (const formatOption of formatOptions) {
        try {
          const options = {
            output: outputPath,
            format: formatOption,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '0',
            noPlaylist: true,
            addHeader: [
              'referer:youtube.com',
              'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
          };

          if (fs.existsSync(COOKIES_PATH)) {
            const cookiesStats = fs.statSync(COOKIES_PATH);
            if (cookiesStats.size > 0) {
              options.cookies = COOKIES_PATH;
            }
          }

          await ytdlp(url, options);
          downloadSuccess = true;
          break;
        } catch (err) {
          lastError = err;
        }
      }

      // Fallback to ytdl-core if yt-dlp is blocked
      if (!downloadSuccess) {
        await downloadAudioWithYtdlCore(url, outputPath);
        downloadSuccess = true;
      }

      // Wait a moment for file system
      await new Promise(resolve => setTimeout(resolve, 500));

      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({
          status: 500,
          success: false,
          creator: CREATOR_NAME,
          error: `File not found after download${lastError?.message ? `: ${lastError.message}` : ''}`
        });
      }

      // schedule deletion
      setTimeout(() => {
        if (fs.existsSync(outputPath)) {
          try {
            fs.unlinkSync(outputPath);
          } catch {}
        }
      }, FILE_CLEANUP_AGE);

      downloadUrl = `${BASE_URL}/download/${filename}`;
    }

    const durationTs = formatDurationTimestamp(videoInfo.duration);

    return res.json({
      status: 200,
      success: true,
      creator: CREATOR_NAME,
      result: {
        quality: '320kbps',
        duration: durationTs,
        title: videoInfo.title,
        thumbnail: videoInfo.thumbnail,
        download_url: downloadUrl
      }
    });
  } catch (error) {
    console.error('PrinceTech ytmp3 error:', error);
    return res.status(500).json({
      status: 500,
      success: false,
      creator: CREATOR_NAME,
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

    // Construct direct download URL
    const downloadUrl = `${BASE_URL}/download/${filename}`;

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

    // Return response with direct downloadable MP4 link
    res.json({
      status: true,
      creator: API_NAME,
      title: videoInfo.title,
      dl: downloadUrl,  // Direct downloadable MP4 link
      thumb: videoInfo.thumbnail,
      duration: videoInfo.duration,
      size: fileSize,
      format: 'mp4'
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
 * Search YouTube videos by name/query
 */
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({
        status: false,
        creator: API_NAME,
        error: 'Query parameter "q" is required'
      });
    }

    // Search YouTube using yt-search
    const searchResults = await yts(q);
    
    if (!searchResults || !searchResults.videos || searchResults.videos.length === 0) {
      return res.json({
        status: true,
        creator: API_NAME,
        query: q,
        results: [],
        message: 'No videos found'
      });
    }

    // Format results
    const videos = searchResults.videos.slice(0, 20).map(video => ({
      videoId: video.videoId,
      title: video.title,
      url: video.url,
      thumbnail: video.thumbnail,
      duration: video.duration ? {
        seconds: video.duration.seconds,
        timestamp: video.duration.timestamp
      } : null,
      views: video.views,
      author: video.author ? {
        name: video.author.name,
        url: video.author.url
      } : null
    }));

    res.json({
      status: true,
      creator: API_NAME,
      query: q,
      results: videos,
      count: videos.length
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      status: false,
      creator: API_NAME,
      error: error.message || 'Search failed'
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
 * Root endpoint - serve the web UI
 */
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({
      status: true,
      creator: API_NAME,
      message: 'YouTube Download API',
      endpoints: {
        search: '/api/search?q=query',
        audio: '/api/downloader/ytmp3?url=YOUTUBE_URL',
        video: '/api/downloader/ytmp4?url=YOUTUBE_URL',
        health: '/health'
      }
    });
  }
});

// Export app for Vercel serverless functions
module.exports = app;

// Only start server if not in Vercel environment
if (!isVercel) {
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
}

