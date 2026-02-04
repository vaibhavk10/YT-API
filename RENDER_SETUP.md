# Render Setup Instructions

## FFmpeg Installation

For the ytdl-core fallback to work, you need to install FFmpeg on Render.

### Option 1: Add to Build Command (Recommended)

In your Render dashboard, add this to your build command:

```bash
apt-get update && apt-get install -y ffmpeg && npm install
```

### Option 2: Use Render's Buildpack

Add this buildpack to your Render service:
- Go to your Render service settings
- Add buildpack: `https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest.git`

### Option 3: Use Environment Variable

Set `FFMPEG_PATH` environment variable if ffmpeg is installed in a custom location.

## How It Works

1. **Primary Method**: Uses yt-dlp with multiple format retries
2. **Fallback Method**: If yt-dlp fails, uses `@distube/ytdl-core` (similar to pytubefix)
   - Gets audio stream directly from YouTube API
   - Converts to MP3 using FFmpeg

## Dependencies

The following packages are required:
- `@distube/ytdl-core` - YouTube downloader (pytubefix equivalent)
- `fluent-ffmpeg` - Audio conversion
- `yt-dlp-exec` - Primary downloader
- `yt-search` - Video search

Install with: `npm install`

