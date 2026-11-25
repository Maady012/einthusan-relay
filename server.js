const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;
const EINTHUSAN_HOST = 'einthusan.tv';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate'
};

function fetchUrl(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const method = options.method || 'GET';
    const postData = options.body || null;
    const reqHeaders = { ...HEADERS, Host: parsed.hostname, ...(options.headers || {}) };

    if (postData) {
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(parsed, {
      method: method,
      headers: reqHeaders,
      rejectUnauthorized: false
    }, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) resolve({ body: buffer.toString('utf-8'), headers: res.headers, status: res.statusCode });
            else resolve({ body: decoded.toString('utf-8'), headers: res.headers, status: res.statusCode });
          });
        } else if (encoding === 'deflate') {
          zlib.inflate(buffer, (err, decoded) => {
            if (err) resolve({ body: buffer.toString('utf-8'), headers: res.headers, status: res.statusCode });
            else resolve({ body: decoded.toString('utf-8'), headers: res.headers, status: res.statusCode });
          });
        } else {
          resolve({ body: buffer.toString('utf-8'), headers: res.headers, status: res.statusCode });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('Timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

function decryptEJ(encryptedData) {
  try {
    const len = encryptedData.length;
    const sliced = encryptedData.slice(0, 10) + encryptedData[len - 1] + encryptedData.slice(12, len - 1);
    const decoded = Buffer.from(sliced, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch (e) {
    return { error: e.message };
  }
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

  if (parsed.pathname === '/health' || parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'einthusan-relay' }));
  }

  if (parsed.pathname === '/debug') {
    const title = parsed.query.title || 'Leo';
    const lang = parsed.query.lang || 'tamil';
    try {
      const searchUrl = `https://${EINTHUSAN_HOST}/movie/results/?lang=${encodeURIComponent(lang)}&query=${encodeURIComponent(title)}`;
      const searchRes = await fetchUrl(searchUrl);
      const watchMatch = searchRes.body.match(/href=["'](\/movie\/watch\/([^"'/]+)\/[^"']*)["']/i);
      if (!watchMatch) return res.end(JSON.stringify({ error: 'not found' }));

      const watchPath = watchMatch[1];
      const videoId = watchMatch[2];
      const watchUrl = `https://${EINTHUSAN_HOST}${watchPath}`;
      const watchRes = await fetchUrl(watchUrl, { headers: { Referer: searchUrl } });

      const pageIdMatch = watchRes.body.match(/data-pageid=["']([^"']+)["']/i);
      const pingablesMatch = watchRes.body.match(/data-ejpingables=["']([^"']+)["']/i);

      let ajaxDebug = null;
      let decrypted = null;
      if (pageIdMatch && pingablesMatch) {
        const ajaxUrl = `https://${EINTHUSAN_HOST}/ajax/movie/watch/${videoId}/`;
        const postBody = new URLSearchParams({
          'xEvent': 'UIVideoPlayer.PingOutcome',
          'xJson': JSON.stringify({
            'EJOutcomes': pingablesMatch[1],
            'NativeHLS': false
          }),
          'arcVersion': '3',
          'appVersion': '59',
          'gorilla.csrf.Token': pageIdMatch[1]
        }).toString();

        const ajaxRes = await fetchUrl(ajaxUrl, {
          method: 'POST',
          body: postBody,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': watchUrl
          }
        });
        ajaxDebug = ajaxRes.body;
        try {
          const json = JSON.parse(ajaxRes.body);
          if (json && json.Data && json.Data.EJLinks) {
            decrypted = decryptEJ(json.Data.EJLinks);
          }
        } catch (e) {
          decrypted = { jsonError: e.message };
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        videoId,
        hasPageId: Boolean(pageIdMatch),
        hasPingables: Boolean(pingablesMatch),
        ajaxRaw: ajaxDebug,
        decrypted: decrypted
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Stream proxy with pipe
  if (parsed.pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400);
      return res.end('Missing url');
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
        const headers = { ...proxyRes.headers };
        headers['access-control-allow-origin'] = '*';
        res.writeHead(proxyRes.statusCode, headers);
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
  console.log(`Relay debug running on port ${PORT}`);
});
