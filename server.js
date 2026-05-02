const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ALLOWED_HOST = '38.226.49.253';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Cache-Control': 'no-cache',
};

function fetchStream(targetUrl, res) {
  const parsed = url.parse(targetUrl);
  const lib = parsed.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.path,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Connection': 'keep-alive',
    },
    timeout: 15000,
  };

  const req = lib.request(options, (proxyRes) => {
    const ct = proxyRes.headers['content-type'] || '';
    const chunks = [];

    proxyRes.on('data', chunk => chunks.push(chunk));
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks);
      const text = body.toString('utf8');

      const isM3u8 = ct.includes('mpegurl') || targetUrl.includes('.m3u8') ||
                     text.includes('#EXTM3U') || text.includes('#EXT-X');

      if (isM3u8) {
        // Rewrite segment URLs to go through this proxy
        const base = targetUrl.replace(/[^\/]*$/, '');
        const proto = process.env.RENDER ? 'https' : 'http';
        const host = process.env.RENDER_EXTERNAL_URL || 
                     `${proto}://localhost:${PORT}`;

        const rewritten = text.split('\n').map(line => {
          const t = line.trim();
          if (!t || t.startsWith('#')) return line;
          const abs = t.startsWith('http') ? t : base + t;
          return `${host}/proxy?url=${encodeURIComponent(abs)}`;
        }).join('\n');

        res.writeHead(200, {
          ...CORS_HEADERS,
          'Content-Type': 'application/vnd.apple.mpegurl',
        });
        res.end(rewritten);
      } else {
        // Binary segment (.ts)
        res.writeHead(200, {
          ...CORS_HEADERS,
          'Content-Type': 'video/MP2T',
        });
        res.end(body);
      }
    });
  });

  req.on('error', (e) => {
    console.error('Proxy error:', e.message);
    res.writeHead(502, CORS_HEADERS);
    res.end('Proxy error: ' + e.message);
  });

  req.on('timeout', () => {
    req.destroy();
    res.writeHead(504, CORS_HEADERS);
    res.end('Gateway timeout');
  });

  req.end();
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  // Health check
  if (parsed.pathname === '/' || parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ status: 'ok', service: 'TvLibre Proxy' }));
    return;
  }

  // Proxy endpoint
  if (parsed.pathname === '/proxy') {
    const targetUrl = parsed.query.url;

    if (!targetUrl) {
      res.writeHead(400, CORS_HEADERS);
      res.end('URL requerida: /proxy?url=...');
      return;
    }

    const decodedUrl = decodeURIComponent(targetUrl);

    if (!decodedUrl.includes(ALLOWED_HOST)) {
      res.writeHead(403, CORS_HEADERS);
      res.end('Host no permitido');
      return;
    }

    console.log(`[PROXY] ${new Date().toISOString()} → ${decodedUrl.substring(0, 80)}`);
    fetchStream(decodedUrl, res);
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`TvLibre Proxy corriendo en puerto ${PORT}`);
});
