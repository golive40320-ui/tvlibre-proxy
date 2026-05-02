const http = require('http');
const https = require('https');

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

// Filter master playlist: keep only H.264 streams, remove HEVC
function filterMaster(text, base) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('#EXT-X-STREAM-INF')) {
      const next = lines[i + 1] ? lines[i + 1].trim() : '';
      // Check codec - skip HEVC (hvc1, hev1, dvh1)
      const isHevc = /CODECS="[^"]*(?:hvc1|hev1|dvh1)/i.test(line);
      if (isHevc) {
        i++; // skip URL line too
        continue;
      }
    }
    out.push(line);
  }
  // Verify we still have streams
  const hasUrl = out.some(l => l.trim() && !l.startsWith('#'));
  return hasUrl ? out.join('\n') : text; // fallback to original if all filtered
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

function send(res, status, ct, body) {
  res.writeHead(status, { ...CORS, 'Content-Type': ct, 'Cache-Control': 'no-cache', 'Content-Length': String(Buffer.isBuffer(body)?body.length:Buffer.byteLength(body)) });
  res.end(body);
}

function handleProxy(targetUrl, req, res) {
  console.log(`→ ${targetUrl.substring(0, 80)}`);
  fetchBuffer(targetUrl, (err, body, ct, status) => {
    if (err) { console.error(err.message); if(!res.headersSent){res.writeHead(502,CORS);res.end(err.message);} return; }
    if (status >= 400) { send(res, status, 'text/plain', `Upstream: ${status}`); return; }

    const text = body.toString('utf8');
    const isM3u8 = ct.includes('mpegurl') || targetUrl.includes('.m3u8') ||
                   text.startsWith('#EXTM3U') || text.includes('#EXT-X-');

    if (isM3u8) {
      const base = targetUrl.replace(/[^\/]*$/, '');
      let processed = text;
      // If master playlist, filter out HEVC
      if (text.includes('#EXT-X-STREAM-INF')) {
        processed = filterMaster(text, base);
        const streamCount = processed.split('\n').filter(l=>l.trim()&&!l.startsWith('#')).length;
        console.log(`[MASTER] streams after HEVC filter: ${streamCount}`);
      }
      send(res, 200, 'application/vnd.apple.mpegurl', rewriteM3u8(processed, base));
    } else {
      console.log(`[TS] ${body.length}b ${ct}`);
      send(res, 200, ct||'video/MP2T', body);
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  let u;
  try { u = new URL(req.url, `http://localhost`); } catch(e) { res.writeHead(400); res.end('bad'); return; }

  if (u.pathname === '/' || u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime().toFixed(0)+'s' }));
    return;
  }

  if (u.pathname === '/proxy') {
    const raw = u.searchParams.get('url');
    if (!raw) { res.writeHead(400, CORS); res.end('falta url'); return; }
    const target = decodeURIComponent(raw);
    if (!target.includes(ALLOWED_HOST)) { res.writeHead(403, CORS); res.end('no permitido'); return; }
    handleProxy(target, req, res); return;
  }

  res.writeHead(404, CORS); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`TvLibre Proxy → ${SELF_URL} :${PORT}`));
