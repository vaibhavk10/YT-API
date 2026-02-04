const API_BASE = window.location.origin;

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const loading = document.getElementById('loading');
const error = document.getElementById('error');
const results = document.getElementById('results');
const resultsList = document.getElementById('resultsList');
const videoInfo = document.getElementById('videoInfo');
const videoTitle = document.getElementById('videoTitle');
const videoThumbnail = document.getElementById('videoThumbnail');
const videoDuration = document.getElementById('videoDuration');
const downloadAudioBtn = document.getElementById('downloadAudioBtn');
const downloadVideoBtn = document.getElementById('downloadVideoBtn');
const testEndpointBtn = document.getElementById('testEndpointBtn');
const testResult = document.getElementById('testResult');
const testStatus = document.getElementById('testStatus');
const testResponse = document.getElementById('testResponse');

let currentVideoUrl = '';

// Search functionality
searchBtn.addEventListener('click', handleSearch);
searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSearch();
});

// Fetch URL functionality
fetchBtn.addEventListener('click', handleFetchUrl);
urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleFetchUrl();
});

// Download buttons
downloadAudioBtn.addEventListener('click', () => downloadVideo('audio'));
downloadVideoBtn.addEventListener('click', () => downloadVideo('video'));
testEndpointBtn.addEventListener('click', testEndpoint);

async function handleSearch() {
    const query = searchInput.value.trim();
    if (!query) {
        showError('Please enter a search query');
        return;
    }

    hideAll();
    showLoading();

    try {
        const response = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}`);
        const data = await response.json();

        if (data.status && data.results && data.results.length > 0) {
            displaySearchResults(data.results);
        } else {
            showError('No videos found. Try a different search term.');
        }
    } catch (err) {
        showError(`Search failed: ${err.message}`);
    } finally {
        hideLoading();
    }
}

async function handleFetchUrl() {
    const url = urlInput.value.trim();
    if (!url) {
        showError('Please enter a YouTube URL');
        return;
    }

    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
        showError('Please enter a valid YouTube URL');
        return;
    }

    currentVideoUrl = url;
    await fetchVideoInfo(url);
}

async function fetchVideoInfo(url) {
    hideAll();
    showLoading();

    try {
        // First get video info using search API if it's a URL
        const videoId = extractVideoId(url);
        if (videoId) {
            const searchResponse = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(videoId)}`);
            const searchData = await searchResponse.json();
            
            if (searchData.status && searchData.results && searchData.results.length > 0) {
                const video = searchData.results[0];
                displayVideoInfo(video);
                return;
            }
        }

        // Fallback: try to get info from download endpoint
        const response = await fetch(`${API_BASE}/api/downloader/ytmp3?url=${encodeURIComponent(url)}`);
        const data = await response.json();

        if (data.status) {
            displayVideoInfoFromResponse(data, url);
        } else {
            showError(data.error || 'Failed to fetch video info');
        }
    } catch (err) {
        showError(`Failed to fetch video info: ${err.message}`);
    } finally {
        hideLoading();
    }
}

function extractVideoId(url) {
    const match = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

function displaySearchResults(videos) {
    resultsList.innerHTML = '';
    videos.forEach(video => {
        const item = createVideoItem(video);
        resultsList.appendChild(item);
    });
    results.classList.remove('hidden');
}

function createVideoItem(video) {
    const div = document.createElement('div');
    div.className = 'video-item';
    div.innerHTML = `
        <img src="${video.thumbnail}" alt="${video.title}">
        <div class="video-item-content">
            <div class="video-item-title">${video.title}</div>
            <div class="video-item-meta">
                ${video.duration ? `Duration: ${video.duration.timestamp}` : ''}
                ${video.views ? ` • ${formatViews(video.views)} views` : ''}
            </div>
        </div>
    `;
    div.addEventListener('click', () => {
        currentVideoUrl = video.url;
        displayVideoInfo(video);
    });
    return div;
}

function displayVideoInfo(video) {
    videoTitle.textContent = video.title;
    videoThumbnail.src = video.thumbnail;
    videoThumbnail.alt = video.title;
    videoDuration.textContent = video.duration 
        ? `Duration: ${video.duration.timestamp} • ${formatViews(video.views || 0)} views`
        : 'Duration: Unknown';
    
    currentVideoUrl = video.url;
    hideAll();
    videoInfo.classList.remove('hidden');
    testResult.classList.add('hidden');
}

function displayVideoInfoFromResponse(data, url) {
    videoTitle.textContent = data.title || 'YouTube Video';
    videoThumbnail.src = data.thumb || '';
    videoDuration.textContent = data.duration 
        ? `Duration: ${formatDuration(data.duration)} • Size: ${formatBytes(data.size || 0)}`
        : 'Duration: Unknown';
    
    currentVideoUrl = url;
    hideAll();
    videoInfo.classList.remove('hidden');
    testResult.classList.add('hidden');
}

async function downloadVideo(type) {
    if (!currentVideoUrl) {
        showError('No video selected');
        return;
    }

    const endpoint = type === 'audio' 
        ? `${API_BASE}/api/downloader/ytmp3?url=${encodeURIComponent(currentVideoUrl)}`
        : `${API_BASE}/api/downloader/ytmp4?url=${encodeURIComponent(currentVideoUrl)}`;

    hideAll();
    showLoading();

    try {
        const response = await fetch(endpoint);
        const data = await response.json();

        if (data.status && data.dl) {
            // Open download link in new tab
            window.open(data.dl, '_blank');
            showSuccess(`Download started! ${type === 'audio' ? 'MP3' : 'MP4'}`);
        } else {
            showError(data.error || 'Download failed');
        }
    } catch (err) {
        showError(`Download failed: ${err.message}`);
    } finally {
        hideLoading();
    }
}

async function testEndpoint() {
    if (!currentVideoUrl) {
        showError('No video selected');
        return;
    }

    hideAll();
    showLoading();
    testResult.classList.remove('hidden');

    try {
        const endpoint = `${API_BASE}/api/downloader/ytmp3?url=${encodeURIComponent(currentVideoUrl)}`;
        const startTime = Date.now();
        
        const response = await fetch(endpoint);
        const data = await response.json();
        const endTime = Date.now();
        const responseTime = endTime - startTime;

        if (data.status) {
            testStatus.className = 'status success';
            testStatus.textContent = `✅ Success! Response time: ${responseTime}ms`;
        } else {
            testStatus.className = 'status error';
            testStatus.textContent = `❌ Failed: ${data.error || 'Unknown error'}`;
        }

        testResponse.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
        testStatus.className = 'status error';
        testStatus.textContent = `❌ Error: ${err.message}`;
        testResponse.textContent = err.toString();
    } finally {
        hideLoading();
    }
}

function showLoading() {
    loading.classList.remove('hidden');
}

function hideLoading() {
    loading.classList.add('hidden');
}

function showError(message) {
    error.textContent = message;
    error.classList.remove('hidden');
}

function hideAll() {
    error.classList.add('hidden');
    results.classList.add('hidden');
    videoInfo.classList.add('hidden');
    testResult.classList.add('hidden');
}

function showSuccess(message) {
    // You can implement a success toast notification here
    console.log('Success:', message);
}

function formatViews(views) {
    if (views >= 1000000) {
        return (views / 1000000).toFixed(1) + 'M';
    } else if (views >= 1000) {
        return (views / 1000).toFixed(1) + 'K';
    }
    return views.toString();
}

function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

