const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const SELF_URL = 'https://tvlibre-proxy.onrender.com';
const ALLOWED_HOST = '38.226.49.253';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
};

let FFMPEG_PATH = 'ffmpeg';
try { FFMPEG_PATH = require('ffmpeg-static'); } catch(e) {}

let ffmpegOk = false;
try {
  const c = spawn(FFMPEG_PATH, ['-version']);
  c.on('close', code => { ffmpegOk = code === 0; console.log('ffmpeg:', ffmpegOk, FFMPEG_PATH); });
  c.on('error', () => {});
} catch(e) {}

function rewriteM3u8(text, base) {
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : base + t;
    return `${SELF_URL}/proxy?url=${encodeURIComponent(abs)}`;
  }).join('\n');
}

function fetchBuffer(url, cb) {
  let u;
  try { u = new URL(url); } catch(e) { return cb(new Error('bad url')); }
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.request({
    hostname: u.hostname,
    port: parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
      'Accept': '*/*', 'Accept-Encoding': 'identity', 'Connection': 'close',
    },
    timeout: 30000,
  }, up => {
    const chunks = [];
    up.on('data', c => chunks.push(c));
    up.on('end', () => cb(null, Buffer.concat(chunks), up.headers['content-type']||'', up.statusCode));
    up.on('error', cb);
  });
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
  req.on('error', cb);
  req.end();
}

function sendWithCors(res, status, contentType, body) {
  // Always include CORS headers
  const headers = { ...CORS, 'Content-Type': contentType, 'Cache-Control': 'no-cache' };
  if (Buffer.isBuffer(body)) headers['Content-Length'] = String(body.length);
  res.writeHead(status, headers);
  res.end(body);
}

function transcodeAndSend(inputBuf, res) {
  // Write CORS headers FIRST before piping
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'video/MP2T',
    'Cache-Control': 'no-cache',
    'Transfer-Encoding': 'chunked',
  });

  const ff = spawn(FFMPEG_PATH, [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '30',
    '-c:a', 'aac', '-b:a', '96k',
    '-f', 'mpegts', 'pipe:1'
  ]);

  ff.stdout.pipe(res, { end: true });
  ff.stdin.write(inputBuf);
  ff.stdin.end();
  ff.stderr.on('data', () => {});
  ff.on('error', e => console.error('ffmpeg err:', e.message));
}

function handleProxy(targetUrl, req, res) {
  console.log(`→ ${targetUrl.substring(0, 80)}`);
  fetchBuffer(targetUrl, (err, body, ct, status) => {
    if (err) {
      console.error('fetch err:', err.message);
      if (!res.headersSent) sendWithCors(res, 502, 'text/plain', err.message);
      return;
    }
    if (status >= 400) {
      sendWithCors(res, status, 'text/plain', `Upstream: ${status}`); return;
    }

    console.log(`← ${status} | ${ct.substring(0,30)} | ${body.length}b`);

    const text = body.toString('utf8');
    const isM3u8 = ct.includes('mpegurl') || targetUrl.includes('.m3u8') ||
                   text.startsWith('#EXTM3U') || text.includes('#EXT-X-');

    if (isM3u8) {
      const base = targetUrl.replace(/[^\/]*$/, '');
      sendWithCors(res, 200, 'application/vnd.apple.mpegurl', rewriteM3u8(text, base));
    } else {
      // Check if HEVC (no H.264 SPS NAL unit found)
      const hasH264sps = body.includes(Buffer.from([0,0,0,1,0x67])) ||
                         body.includes(Buffer.from([0,0,1,0x67]));
      const isTs = targetUrl.includes('.ts') || ct.includes('MP2T') || ct.includes('mpeg');
      const needsTranscode = ffmpegOk && isTs && !hasH264sps && body.length > 10000;

      if (needsTranscode) {
        console.log(`[TRANSCODE] ${body.length}b`);
        transcodeAndSend(body, res);
      } else {
        sendWithCors(res, 200, ct || 'video/MP2T', body);
      }
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  let u;
  try { u = new URL(req.url, `http://localhost`); }
  catch(e) { res.writeHead(400); res.end('bad'); return; }

  if (u.pathname === '/' || u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true, ffmpeg: ffmpegOk, uptime: process.uptime().toFixed(0)+'s' }));
    return;
  }

  if (u.pathname === '/proxy') {
    const raw = u.searchParams.get('url');
    if (!raw) { res.writeHead(400, CORS); res.end('falta url'); return; }
    const target = decodeURIComponent(raw);
    if (!target.includes(ALLOWED_HOST)) { res.writeHead(403, CORS); res.end('no permitido'); return; }
    handleProxy(target, req, res);
    return;
  }

  res.writeHead(404, CORS); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`TvLibre Proxy → ${SELF_URL} :${PORT}`));
