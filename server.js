const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SELF_URL = 'https://tvlibre-proxy.onrender.com';
const ALLOWED_HOST = '38.226.49.253';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
};

// Try to find ffmpeg — native first, then ffmpeg-static package
let FFMPEG_PATH = 'ffmpeg';
try {
  FFMPEG_PATH = require('ffmpeg-static');
  console.log('Using ffmpeg-static:', FFMPEG_PATH);
} catch(e) {
  console.log('Using system ffmpeg');
}

let ffmpegAvailable = false;
const check = spawn(FFMPEG_PATH, ['-version']);
check.on('close', c => { ffmpegAvailable = c === 0; console.log('ffmpeg ready:', ffmpegAvailable); });
check.on('error', () => console.log('ffmpeg not found'));

function rewriteM3u8(text, base) {
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : base + t;
    return `${SELF_URL}/proxy?url=${encodeURIComponent(abs)}`;
  }).join('\n');
}

function fetchBuffer(targetUrl, cb) {
  let u;
  try { u = new URL(targetUrl); } catch(e) { return cb(new Error('URL inválida')); }
  const lib = u.protocol === 'https:' ? https : http;
  const opts = {
    hostname: u.hostname,
    port: parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
      'Accept': '*/*', 'Accept-Encoding': 'identity', 'Connection': 'close',
    },
    timeout: 30000,
  };
  const req = lib.request(opts, upstream => {
    const chunks = [];
    upstream.on('data', c => chunks.push(c));
    upstream.on('end', () => cb(null, Buffer.concat(chunks), upstream.headers['content-type'] || '', upstream.statusCode));
    upstream.on('error', cb);
  });
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
  req.on('error', cb);
  req.end();
}

function transcodeToH264(inputBuf, res) {
  console.log(`[TRANSCODE] ${inputBuf.length}b HEVC→H264`);
  const ff = spawn(FFMPEG_PATH, [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
    '-c:a', 'aac', '-b:a', '96k',
    '-f', 'mpegts', 'pipe:1'
  ]);
  res.writeHead(200, { ...CORS, 'Content-Type': 'video/MP2T', 'Cache-Control': 'no-cache' });
  ff.stdout.pipe(res);
  ff.stdin.write(inputBuf);
  ff.stdin.end();
  ff.on('error', e => { console.error('ffmpeg err:', e.message); });
}

function handleRequest(targetUrl, req, res) {
  console.log(`→ ${targetUrl.substring(0, 80)}`);
  fetchBuffer(targetUrl, (err, body, ct, status) => {
    if (err) {
      console.error('Err:', err.message);
      if (!res.headersSent) { res.writeHead(502, CORS); res.end(err.message); }
      return;
    }
    if (status >= 400) {
      res.writeHead(status, { ...CORS, 'Content-Type': 'text/plain' });
      res.end(`Upstream: ${status}`); return;
    }
    console.log(`← ${status} | ${ct.substring(0,30)} | ${body.length}b`);

    const text = body.toString('utf8');
    const isM3u8 = ct.includes('mpegurl') || targetUrl.includes('.m3u8') ||
                   text.startsWith('#EXTM3U') || text.includes('#EXT-X-');

    if (isM3u8) {
      const base = targetUrl.replace(/[^\/]*$/, '');
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      res.end(rewriteM3u8(text, base));
    } else {
      // Detect HEVC by checking for H.264 start codes absence
      const hasH264 = body.includes(Buffer.from([0x00,0x00,0x00,0x01,0x67])) ||
                      body.includes(Buffer.from([0x00,0x00,0x01,0x67]));
      const likelyHevc = !hasH264 && body.length > 5000 && targetUrl.includes('.ts');

      if (ffmpegAvailable && likelyHevc) {
        transcodeToH264(body, res);
      } else {
        res.writeHead(200, { ...CORS, 'Content-Type': ct||'video/MP2T', 'Content-Length': String(body.length), 'Cache-Control': 'no-cache' });
        res.end(body);
      }
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  let u;
  try { u = new URL(req.url, `http://localhost:${PORT}`); }
  catch(e) { res.writeHead(400); res.end('Bad'); return; }

  if (u.pathname === '/' || u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true, ffmpeg: ffmpegAvailable, ffmpegPath: FFMPEG_PATH, uptime: process.uptime().toFixed(0)+'s' }));
    return;
  }
  if (u.pathname === '/proxy') {
    const raw = u.searchParams.get('url');
    if (!raw) { res.writeHead(400, CORS); res.end('Falta ?url='); return; }
    const target = decodeURIComponent(raw);
    if (!target.includes(ALLOWED_HOST)) { res.writeHead(403, CORS); res.end('No permitido'); return; }
    handleRequest(target, req, res); return;
  }
  res.writeHead(404, CORS); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`TvLibre Proxy → ${SELF_URL} (port ${PORT})`));
