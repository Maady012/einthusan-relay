const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;

// Upstream Einthusan Base
const EINTHUSAN_HOST = 'einthusan.tv';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate'
};

function fetchUrl(targetUrl, headers = HEADERS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const req = https.request(parsed, {
      method: 'GET',
      headers: { ...headers, Host: parsed.hostname }
    }, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) resolve(buffer.toString('utf-8'));
            else resolve(decoded.toString('utf-8'));
          });
        } else if (encoding === 'deflate') {
          zlib.inflate(buffer, (err, decoded) => {
            if (err) resolve(buffer.toString('utf-8'));
            else resolve(decoded.toString('utf-8'));
          });
        } else {
          resolve(buffer.toString('utf-8'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('Timeout')); });
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Endpoint 1: Health
  if (parsed.pathname === '/health' || parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'einthusan-relay' }));
  }

  // Endpoint 2: Resolve stream for title & lang
  if (parsed.pathname === '/resolve') {
    const title = parsed.query.title;
    const lang = parsed.query.lang || 'tamil';
    if (!title) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing title query parameter' }));
    }

    try {
      const searchUrl = `https://${EINTHUSAN_HOST}/movie/results/?lang=${encodeURIComponent(lang)}&query=${encodeURIComponent(title)}`;
      const searchHtml = await fetchUrl(searchUrl);
      
      const watchMatch = searchHtml.match(/href=["'](\/movie\/watch\/[^"']+)["']/i);
      if (!watchMatch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Movie not found on Einthusan' }));
      }

      const watchPath = watchMatch[1];
      const watchUrl = `https://${EINTHUSAN_HOST}${watchPath}`;
      const watchHtml = await fetchUrl(watchUrl, { ...HEADERS, Referer: searchUrl });

      const hlsMatch = watchHtml.match(/data-hls-link=["']([^"']+)["']/i);
      const mp4Match = watchHtml.match(/data-mp4-link=["']([^"']+)["']/i);
      let rawStream = (hlsMatch ? hlsMatch[1] : (mp4Match ? mp4Match[1] : null));

      if (rawStream) {
        rawStream = rawStream.replace(/&amp;/g, '&');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          title: title,
          lang: lang,
          watchUrl: watchUrl,
          streamUrl: rawStream,
          isHLS: Boolean(hlsMatch)
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Player data links not found in HTML' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Endpoint 3: Video Stream Proxy
  if (parsed.pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400);
      return res.end('Missing url param');
    }

    try {
      const targetUrl = new URL(target);
      const isHttps = targetUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const proxyReq = client.request(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Referer': `https://${EINTHUSAN_HOST}/`,
          'Range': req.headers['range'] || 'bytes=0-'
        },
        rejectUnauthorized: false
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', err => {
        if (!res.headersSent) res.writeHead(502);
        res.end(err.message);
      });
      req.pipe(proxyReq);
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Einthusan relay running on port ${PORT}`);
});
