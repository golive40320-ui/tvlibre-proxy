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
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Connection': 'close',
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

// Check if ffmpeg is available for transcoding
let ffmpegAvailable = false;
const ffmpegCheck = spawn('ffmpeg', ['-version']);
ffmpegCheck.on('close', code => {
  ffmpegAvailable = code === 0;
  console.log(`ffmpeg available: ${ffmpegAvailable}`);
});
ffmpegCheck.on('error', () => { ffmpegAvailable = false; console.log('ffmpeg not available'); });

function transcodeTs(inputBuffer, res) {
  // Use ffmpeg to convert HEVC .ts to H.264 .ts
  const ff = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'mpegts',
    'pipe:1'
  ]);

  res.writeHead(200, { ...CORS, 'Content-Type': 'video/MP2T', 'Cache-Control': 'no-cache' });

  ff.stdout.pipe(res);
  ff.stdin.write(inputBuffer);
  ff.stdin.end();

  ff.stderr.on('data', d => {}); // suppress ffmpeg logs
  ff.on('error', e => { console.error('ffmpeg error:', e.message); if(!res.headersSent) { res.writeHead(502, CORS); res.end('Transcode error'); } });
}

function handleRequest(targetUrl, req, res) {
  console.log(`→ ${targetUrl.substring(0, 90)}`);

  fetchBuffer(targetUrl, (err, body, ct, status) => {
    if (err) {
      console.error('Fetch error:', err.message);
      if (!res.headersSent) { res.writeHead(502, CORS); res.end(err.message); }
      return;
    }

    if (status >= 400) {
      res.writeHead(status, { ...CORS, 'Content-Type': 'text/plain' });
      res.end(`Upstream: ${status}`);
      return;
    }

    console.log(`← ${status} | ${ct.substring(0,40)} | ${body.length}b`);

    const text = body.toString('utf8');
    const isM3u8 = ct.includes('mpegurl') || targetUrl.includes('.m3u8') ||
                   text.startsWith('#EXTM3U') || text.includes('#EXT-X-');

    if (isM3u8) {
      const base = targetUrl.replace(/[^\/]*$/, '');
      const rewritten = rewriteM3u8(text, base);
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      res.end(rewritten);
    } else {
      // Binary segment — try to detect HEVC and transcode if possible
      const isHevc = body.length > 4 && (
        body.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67])) === -1 && // no H.264 SPS
        body.indexOf(Buffer.from([0x00, 0x00, 0x01, 0x67])) === -1
      );

      if (ffmpegAvailable && isHevc && body.length > 10000) {
        console.log(`[TRANSCODE] ${body.length}b HEVC→H264`);
        transcodeTs(body, res);
      } else {
        res.writeHead(200, { ...CORS, 'Content-Type': ct || 'video/MP2T', 'Content-Length': String(body.length), 'Cache-Control': 'no-cache' });
        res.end(body);
      }
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  let u;
  try { u = new URL(req.url, `http://localhost:${PORT}`); }
  catch(e) { res.writeHead(400); res.end('Bad request'); return; }

  if (u.pathname === '/' || u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true, ffmpeg: ffmpegAvailable, self: SELF_URL, uptime: process.uptime().toFixed(0)+'s' }));
    return;
  }

  if (u.pathname === '/proxy') {
    const raw = u.searchParams.get('url');
    if (!raw) { res.writeHead(400, CORS); res.end('Falta ?url='); return; }
    const target = decodeURIComponent(raw);
    if (!target.includes(ALLOWED_HOST)) { res.writeHead(403, CORS); res.end('Host no permitido'); return; }
    handleRequest(target, req, res);
    return;
  }

  res.writeHead(404, CORS); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`TvLibre Proxy → ${SELF_URL} (port ${PORT})`));
