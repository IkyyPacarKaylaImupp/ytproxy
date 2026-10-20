const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const mime = require('mime-types');
const path = require('path');

const app = express();
app.use(express.json());

// ==========================================
// KONFIGURASI GITHUB (CDN)
// ==========================================
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'IkyyPacarKaylaImupp'; 
const GITHUB_REPO = process.env.GITHUB_REPO || 'cdnku';       
const STORAGE_BRANCH = 'main'; 
const METADATA_PATH = 'metadata.json';

// Setup Multer
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 50 * 1024 * 1024 } 
});

// ==========================================
// HELPER: METADATA DI GITHUB
// ==========================================
async function getMetadata() {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${METADATA_PATH}`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    return {
      data: JSON.parse(Buffer.from(res.data.content, 'base64').toString()),
      sha: res.data.sha
    };
  } catch (err) {
    if (err.response?.status === 404) return { data: {}, sha: null };
    throw err;
  }
}

async function saveMetadata(newData, sha) {
  const content = Buffer.from(JSON.stringify(newData, null, 2)).toString('base64');
  await axios.put(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${METADATA_PATH}`,
    { message: 'Update CDN metadata', content, sha, branch: STORAGE_BRANCH },
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
  );
}

// ==========================================
// 1. ROOT ENDPOINT
// ==========================================
app.get('/', (req, res) => {
  res.send('Vercel YT Proxy & CDN Active ✅');
});

// ==========================================
// 2. UPLOAD ENDPOINT (CDN)
// ==========================================
app.post('/api/upload.php', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file' });
    
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const filename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const token = crypto.randomBytes(64).toString('hex'); // Token 128 char
    const githubPath = `storage/${filename}`;
    
    await axios.put(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${githubPath}`,
      {
        message: `Upload: ${filename}`,
        content: req.file.buffer.toString('base64'),
        branch: STORAGE_BRANCH
      },
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    
    const { data: meta, sha } = await getMetadata();
    meta[token] = { 
      filename, originalName: req.file.originalname, 
      type: ext, size: req.file.size, 
      uploadedAt: new Date().toISOString(), githubPath 
    };
    await saveMetadata(meta, sha);
    
    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    
    res.json({ 
      success: true, 
      data: { url: `${baseUrl}/st-v2/ikyapis?type=${ext}/token=${token}` } 
    });
  } catch (err) {
    console.error('Upload Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 3. ACCESS ENDPOINT (CDN STREAMING)
// ==========================================
app.get('/st-v2/ikyapis', async (req, res) => {
  try {
    let type, token;
    const queryStr = req.originalUrl.split('?')[1] || '';
    
    let separator = null;
    if (queryStr.includes('%2Ftoken%3D')) separator = '%2Ftoken%3D';
    else if (queryStr.includes('%2Ftoken=')) separator = '%2Ftoken=';
    else if (queryStr.includes('/token%3D')) separator = '/token%3D';
    else if (queryStr.includes('/token=')) separator = '/token=';
    
    if (separator) {
      const parts = queryStr.split(separator);
      const typePart = parts[0];
      type = typePart.includes('=') ? typePart.split('=')[1] : typePart;
      token = parts[1];
    } else {
      type = req.query.type;
      token = req.query.token;
    }

    if (!type || !token || type.length > 10 || token.length < 50) {
      return res.status(400).json({ message: 'Missing or invalid params' });
    }
    
    const { data: meta } = await getMetadata();
    const fileData = meta[token];
    
    if (!fileData || fileData.type !== type) {
      return res.status(404).json({ message: 'Not found or invalid token' });
    }
    
    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${STORAGE_BRANCH}/${fileData.githubPath}`;
    const response = await axios.get(rawUrl, { responseType: 'stream', timeout: 30000 });

    res.setHeader('Content-Type', mime.lookup(`.${type}`) || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('X-Powered-By', 'IkyyCDN-Secure');
    
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    
    response.data.pipe(res);
    response.data.on('error', () => {
      if (!res.headersSent) res.status(502).end('Stream interrupted');
    });

  } catch (err) {
    console.error('Access Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. YOUTUBE PROXY ENDPOINT (BYPASS IP)
// ==========================================
app.get('/yt-proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl || !targetUrl.includes('googlevideo.com')) {
    return res.status(400).json({ error: 'Invalid URL. Must be a googlevideo.com link.' });
  }

  try {
    // Spoof header biar dikira browser Chrome asli
    const response = await axios.get(targetUrl, {
      responseType: 'stream',
      maxRedirects: 5,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com',
        'Range': req.headers['range'] || 'bytes=0-' // Support seeking
      }
    });

    const contentType = response.headers['content-type'] || 'video/mp4';
    const contentLength = response.headers['content-length'];
    const contentRange = response.headers['content-range'];
    const statusCode = contentRange ? 206 : 200;
    
    res.writeHead(statusCode, {
      'Content-Type': contentType,
      'Content-Length': contentLength,
      'Content-Range': contentRange,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length'
    });

    response.data.pipe(res);
    response.data.on('error', () => {
      if (!res.headersSent) res.status(502).end('Stream Failed');
    });

  } catch (error) {
    console.error('YT Proxy Error:', error.response?.status, error.message);
    if (!res.headersSent) {
      res.status(error.response?.status || 500).json({ 
        error: 'Failed to proxy video', 
        details: error.message 
      });
    }
  }
});

module.exports = app;
