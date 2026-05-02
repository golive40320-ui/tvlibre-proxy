const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const ALLOWED_HOST = '38.226.49.253';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type',
  'Cache-Control': 'no-cache, no-store',
};

function proxyRequest(targetUrl, res) {
  let u;
  try { u = new URL(targetUrl); } catch(e) {
    res.writeHead(400, CORS); res.end('URL inválida'); return;
  }

  const lib = u.protocol === 'https:' ? https : http;
  const opts = {
    hostname: u.hostname,
    port: parseInt(u.port) || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      'Connection': 'close',
      'Referer': `http://${u.hostname}:${u.port}/`,
    },
    timeout: 25000,
  };

  console.log(`→ ${targetUrl.substring(0, 80)}`);

  const req = lib.request(opts, (upstream) => {
    const ct = upstream.headers['content-type'] || '';
    console.log(`← ${upstream.statusCode} ${ct.substring(0,40)}`);

    if (upstream.statusCode >= 400) {
      res.writeHead(upstream.statusCode, CORS);
      res.end(`Upstream error: ${upstream.statusCode}`);
      return;
    }

    const chunks = [];
    upstream.on('data', c => chunks.push(c));
    upstream.on('end', () => {
      const body = Buffer.concat(chunks);
      const text = body.toString('utf8');
      const isM3u8 = ct.includes('mpegurl') || targetUrl.includes('.m3u8') ||
                     text.startsWith('#EXTM3U') || text.includes('#EXT-X-');

      if (isM3u8) {
        const base = targetUrl.replace(/[^\/]*$/, '');
        const rewritten = text.split('\n').map(line => {
          const t = line.trim();
          if (!t || t.startsWith('#')) return line;
          const abs = t.startsWith('http') ? t : base + t;
          return `${SELF_URL}/proxy?url=${encodeURIComponent(abs)}`;
        }).join('\n');

        res.writeHead(200, { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(rewritten);
      } else {
        // Binary .ts segment
        res.writeHead(200, { ...CORS, 'Content-Type': 'video/MP2T' });
        res.end(body);
      }
    });

    upstream.on('error', e => {
      console.error('Upstream stream error:', e.message);
      if (!res.headersSent) { res.writeHead(502, CORS); res.end(e.message); }
    });
  });

  req.on('timeout', () => {
    req.destroy();
    console.error('Timeout connecting to:', targetUrl);
    if (!res.headersSent) { res.writeHead(504, CORS); res.end('Timeout'); }
  });

  req.on('error', e => {
    console.error(`Connection error [${e.code}]:`, e.message);
    if (!res.headersSent) {
      res.writeHead(502, CORS);
      res.end(JSON.stringify({ error: e.code, msg: e.message }));
    }
  });

  req.end();
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS); res.end(); return;
  }

  let u;
  try { u = new URL(req.url, `http://localhost:${PORT}`); }
  catch(e) { res.writeHead(400); res.end('Bad URL'); return; }

  // Health
  if (u.pathname === '/' || u.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ ok: true, self: SELF_URL, time: new Date().toISOString() }));
    return;
  }

  // Proxy
  if (u.pathname === '/proxy') {
    const raw = u.searchParams.get('url');
    if (!raw) { res.writeHead(400, CORS); res.end('Falta ?url='); return; }
    const target = decodeURIComponent(raw);
    if (!target.includes(ALLOWED_HOST)) {
      res.writeHead(403, CORS); res.end('Host no permitido'); return;
    }
    proxyRequest(target, res);
    return;
  }

  res.writeHead(404, CORS); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TvLibre Proxy corriendo en ${SELF_URL} (puerto ${PORT})`);
});
