const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const ALLOWED_HOST = '38.226.49.253';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Cache-Control': 'no-cache',
};

function proxyRequest(targetUrl, res) {
  const u = new URL(targetUrl);
  const lib = u.protocol === 'https:' ? https : http;

  const opts = {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Connection': 'close',
    },
    timeout: 20000,
  };

  console.log(`[${new Date().toISOString()}] → ${targetUrl}`);

  const req = lib.request(opts, (upstream) => {
    const ct = upstream.headers['content-type'] || '';
    const status = upstream.statusCode;
    console.log(`[${new Date().toISOString()}] ← ${status} ${ct}`);

    const chunks = [];
    upstream.on('data', c => chunks.push(c));
    upstream.on('end', () => {
      const body = Buffer.concat(chunks);
      const text = body.toString('utf8');
      const isM3u8 = ct.includes('mpegurl') || targetUrl.includes('.m3u8') ||
                     text.startsWith('#EXTM3U') || text.includes('#EXT-X');

      if (isM3u8) {
        const base = targetUrl.replace(/[^\/]*$/, '');
        const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

        const rewritten = text.split('\n').map(line => {
          const t = line.trim();
          if (!t || t.startsWith('#')) return line;
          const abs = t.startsWith('http') ? t : base + t;
          return `${selfUrl}/proxy?url=${encodeURIComponent(abs)}`;
        }).join('\n');

        res.writeHead(200, { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(rewritten);
      } else {
        res.writeHead(200, { ...CORS, 'Content-Type': 'video/MP2T' });
        res.end(body);
      }
    });
  });

  req.on('timeout', () => {
    req.destroy();
    res.writeHead(504, CORS);
    res.end(JSON.stringify({ error: 'timeout', url: targetUrl }));
  });

  req.on('error', (e) => {
    console.error(`[ERROR] ${e.code} — ${e.message}`);
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.code, message: e.message, url: targetUrl }));
  });

  req.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS); res.end(); return;
  }

  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (u.pathname === '/' || u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ status: 'ok', service: 'TvLibre Proxy', time: new Date() }));
    return;
  }

  if (u.pathname === '/proxy') {
    const target = u.searchParams.get('url');
    if (!target) { res.writeHead(400, CORS); res.end('Falta ?url='); return; }
    const decoded = decodeURIComponent(target);
    if (!decoded.includes(ALLOWED_HOST)) {
      res.writeHead(403, CORS); res.end('Host no permitido'); return;
    }
    proxyRequest(decoded, res);
    return;
  }

  res.writeHead(404, CORS); res.end('Not found');
});

server.listen(PORT, () => console.log(`TvLibre Proxy en puerto ${PORT}`));
