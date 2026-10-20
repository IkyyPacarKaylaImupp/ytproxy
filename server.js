const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const mime = require('mime-types');
const path = require('path');
const https = require('https'); // Untuk cek IP publik server

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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Helper Metadata GitHub
async function getMetadata() {
  try {
    const res = await axios.get(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${METADATA_PATH}`, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } });
    return { data: JSON.parse(Buffer.from(res.data.content, 'base64').toString()), sha: res.data.sha };
  } catch (err) { if (err.response?.status === 404) return { data: {}, sha: null }; throw err; }
}
async function saveMetadata(newData, sha) {
  await axios.put(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${METADATA_PATH}`, 
    { message: 'Update CDN metadata', content: Buffer.from(JSON.stringify(newData, null, 2)).toString('base64'), sha, branch: STORAGE_BRANCH },
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } });
}

// ==========================================
// HELPER: GET SERVER IP (Untuk Fix YouTube 403)
// ==========================================
let cachedServerIp = null;
async function getServerIp() {
  if (cachedServerIp) return cachedServerIp;
  try {
    const res = await axios.get('https://api.ipify.org?format=json');
    cachedServerIp = res.data.ip;
    return cachedServerIp;
  } catch (e) { return null; }
}

// ==========================================
// ENDPOINTS
// ==========================================
app.get('/', (req, res) => res.send('Vercel YT Proxy & CDN Active ✅'));

// UPLOAD CDN
app.post('/api/upload.php', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file' });
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const filename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const token = crypto.randomBytes(64).toString('hex');
    
    await axios.put(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/storage/${filename}`,
      { message: `Upload: ${filename}`, content: req.file.buffer.toString('base64'), branch: STORAGE_BRANCH },
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } });
      
    const { data: meta, sha } = await getMetadata();
    meta[token] = { filename, originalName: req.file.originalname, type: ext, size: req.file.size, uploadedAt: new Date().toISOString(), githubPath: `storage/${filename}` };
    await saveMetadata(meta, sha);
    
    res.json({ success: true, data: { url: `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/st-v2/ikyapis?type=${ext}/token=${token}` } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ACCESS CDN
app.get('/st-v2/ikyapis', async (req, res) => {
  try {
    let type, token;
    const queryStr = req.originalUrl.split('?')[1] || '';
    let separator = queryStr.includes('%2Ftoken%3D') ? '%2Ftoken%3D' : queryStr.includes('%2Ftoken=') ? '%2Ftoken=' : queryStr.includes('/token%3D') ? '/token%3D' : '/token=';
    
    if (queryStr.includes('token')) {
      const parts = queryStr.split(separator);
      type = parts[0].split('=')[1]; token = parts[1];
    } else { type = req.query.type; token = req.query.token; }

    if (!type || !token || token.length < 50) return res.status(400).json({ message: 'Invalid params' });
    
    const { data: meta } = await getMetadata();
    const fileData = meta[token];
    if (!fileData || fileData.type !== type) return res.status(404).json({ message: 'Not found' });
    
    const response = await axios.get(`https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${STORAGE_BRANCH}/${fileData.githubPath}`, { responseType: 'stream', timeout: 30000 });
    res.setHeader('Content-Type', mime.lookup(`.${type}`) || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    response.data.pipe(res);
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

// ==========================================
// YOUTUBE PROXY (FIXED IP VALIDATION)
// ==========================================
app.get('/yt-proxy', async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl || !targetUrl.includes('googlevideo.com')) return res.status(400).json({ error: 'Invalid URL' });

  try {
    // 1. DECODE URL DULU BIAR BISA MANIPULASI PARAMETER
    targetUrl = decodeURIComponent(targetUrl);
    
    // 2. AMBIL IP SERVER VERCEL SAAT INI
    const serverIp = await getServerIp();
    
    // 3. MANIPULASI URL UNTUK BYPASS 403
    // YouTube mengecek parameter &ip=. Kita ganti dengan IP server kita atau hapus jika memungkinkan.
    // Regex ini mencari &ip=... sampai & berikutnya atau akhir string
    if (serverIp) {
        // Opsi A: Ganti IP di URL dengan IP Server (Paling aman untuk signature)
        targetUrl = targetUrl.replace(/&ip=[^&]+/gi, `&ip=${serverIp}`);
        
        // Opsi B: Jika masih 403, coba hapus parameter ip sama sekali (kadang work untuk link lama)
        // targetUrl = targetUrl.replace(/&ip=[^&]+/gi, ''); 
    }

    console.log('Proxying to sanitized URL:', targetUrl.substring(0, 100) + '...');

    // 4. REQUEST DENGAN HEADER SPOOFING LENGKAP
    const response = await axios.get(targetUrl, {
      responseType: 'stream',
      maxRedirects: 5,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', // Referer ke video dummy biar valid
        'Origin': 'https://www.youtube.com',
        'Range': req.headers['range'] || 'bytes=0-'
      }
    });

    // 5. STREAMING KE CLIENT
    const contentType = response.headers['content-type'] || 'video/mp4';
    const contentLength = response.headers['content-length'];
    const contentRange = response.headers['content-range'];
    
    res.writeHead(contentRange ? 206 : 200, {
      'Content-Type': contentType,
      'Content-Length': contentLength,
      'Content-Range': contentRange,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });

    response.data.pipe(res);
    response.data.on('error', () => { if (!res.headersSent) res.status(502).end('Stream Failed'); });

  } catch (error) {
    console.error('YT Proxy Error:', error.response?.status, error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Proxy failed', details: error.message });
  }
});

module.exports = app;
