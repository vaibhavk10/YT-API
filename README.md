# YouTube Download API Server

A standalone API server for downloading YouTube videos and audio using yt-dlp.

## Features

- 🎵 Download YouTube audio (MP3)
- 🎬 Download YouTube videos (MP4)
- 📊 Extract video metadata (title, duration, thumbnail)
- 🧹 Automatic file cleanup
- 🌐 CORS enabled
- 📦 Okatsu-style API response format

## Prerequisites

- **Node.js** (v14 or higher)
- **Python** (v3.7 or higher) - Required for yt-dlp
- **yt-dlp** - Will be installed via npm package

### Installing Python and yt-dlp

#### Windows
```bash
# Install Python from python.org
# Then install yt-dlp
pip install yt-dlp
```

#### Linux/Mac
```bash
# Install Python (usually pre-installed)
python3 --version

# Install yt-dlp
pip3 install yt-dlp
# or
brew install yt-dlp  # macOS
```

## Installation

1. **Navigate to the api folder:**
   ```bash
   cd api
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` file with your configuration:
   ```env
   PORT=3000
   BASE_URL=http://localhost:3000
   API_NAME=YouTube Download API
   ```

4. **Optional: Add cookies.txt**
   - Place your `cookies.txt` file in the `api/` folder
   - This helps bypass age-restricted and private video restrictions
   - The server will automatically use it if present

## Usage

### Start the server:

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

The server will start on `http://localhost:3000` (or your configured PORT).

## API Endpoints

### Download Audio (MP3)

**GET** `/api/downloader/ytmp3?url=YOUTUBE_URL`

**Example:**
```bash
curl "http://localhost:3000/api/downloader/ytmp3?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

**Response:**
```json
{
  "status": true,
  "creator": "YouTube Download API",
  "title": "Video Title",
  "dl": "http://localhost:3000/downloads/audio_1234567890.mp3",
  "thumb": "https://i.ytimg.com/vi/VIDEO_ID/hqdefault.jpg",
  "duration": 180,
  "size": 5242880
}
```

### Download Video (MP4)

**GET** `/api/downloader/ytmp4?url=YOUTUBE_URL`

**Example:**
```bash
curl "http://localhost:3000/api/downloader/ytmp4?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

**Response:**
```json
{
  "status": true,
  "creator": "YouTube Download API",
  "title": "Video Title",
  "dl": "http://localhost:3000/downloads/video_1234567890.mp4",
  "thumb": "https://i.ytimg.com/vi/VIDEO_ID/hqdefault.jpg",
  "duration": 180,
  "size": 15728640
}
```

### Health Check

**GET** `/health`

**Response:**
```json
{
  "status": true,
  "message": "API is running",
  "creator": "YouTube Download API"
}
```

### Root Endpoint

**GET** `/`

Returns API information and available endpoints.

## Error Responses

If an error occurs, the API returns:

```json
{
  "status": false,
  "creator": "YouTube Download API",
  "error": "Error message here"
}
```

## File Management

- Downloaded files are stored in the `downloads/` directory
- Files are automatically cleaned up after 1 hour (configurable via `FILE_CLEANUP_AGE`)
- Cleanup runs every 30 minutes

## Configuration

Edit the `.env` file to configure:

- `PORT` - Server port (default: 3000)
- `BASE_URL` - Base URL for download links (default: http://localhost:3000)
- `API_NAME` - API name in responses
- `FILE_CLEANUP_AGE` - File cleanup age in milliseconds (default: 3600000 = 1 hour)

## Deployment

### Local Testing

1. Make sure Python and yt-dlp are installed
2. Run `npm install`
3. Run `npm start`
4. Test with: `http://localhost:3000/api/downloader/ytmp3?url=YOUTUBE_URL`

### Production Deployment

1. Set `BASE_URL` to your production domain
2. Use a process manager like PM2:
   ```bash
   npm install -g pm2
   pm2 start server.js --name youtube-api
   ```
3. Set up reverse proxy (nginx/Apache) if needed
4. Configure firewall to allow your PORT

## Troubleshooting

### "Couldn't find the `python` binary"
- Make sure Python is installed and in your PATH
- On Windows, you may need to add Python to PATH during installation

### "yt-dlp-exec" installation fails
- Ensure Python is installed first
- Try: `pip install yt-dlp` manually
- Then: `npm install yt-dlp-exec`

### Downloads fail
- Check if the YouTube URL is valid
- Some videos may be age-restricted or private (cookies.txt helps)
- Check server logs for detailed error messages

### Files not being served
- Ensure `downloads/` directory exists and is writable
- Check `BASE_URL` in `.env` matches your server URL
- Verify file permissions

## License

MIT

## Notes

- This API requires Python and yt-dlp to be installed on the server
- Files are served directly from the server (for production, consider using cloud storage/CDN)
- Rate limiting is not implemented - consider adding it for production use
- The API is designed for testing and development - add authentication/rate limiting for production

