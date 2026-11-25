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

function fetchWithCookies(targetUrl, options = {}) {
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
        const cookies = res.headers['set-cookie'] || [];

        const finish = (decodedStr) => {
          resolve({ body: decodedStr, headers: res.headers, cookies: cookies, status: res.statusCode });
        };

        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) finish(buffer.toString('utf-8'));
            else finish(decoded.toString('utf-8'));
          });
        } else if (encoding === 'deflate') {
          zlib.inflate(buffer, (err, decoded) => {
            if (err) finish(buffer.toString('utf-8'));
            else finish(decoded.toString('utf-8'));
          });
        } else {
          finish(buffer.toString('utf-8'));
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
    return null;
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

  if (parsed.pathname === '/resolve') {
    const title = parsed.query.title;
    const lang = parsed.query.lang || 'tamil';
    if (!title) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing title' }));
    }

    try {
      const searchUrl = `https://${EINTHUSAN_HOST}/movie/results/?lang=${encodeURIComponent(lang)}&query=${encodeURIComponent(title)}`;
      const searchRes = await fetchWithCookies(searchUrl);
      
      const watchMatch = searchRes.body.match(/href=["'](\/movie\/watch\/([^"'/]+)\/[^"']*)["']/i);
      if (!watchMatch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Movie not found on Einthusan' }));
      }

      const watchPath = watchMatch[1];
      const videoId = watchMatch[2];
      const watchUrl = `https://${EINTHUSAN_HOST}${watchPath}`;
      
      // Pass cookies from search to watch
      let cookieHeader = searchRes.cookies.map(c => c.split(';')[0]).join('; ');
      const watchRes = await fetchWithCookies(watchUrl, {
        headers: { Referer: searchUrl, Cookie: cookieHeader }
      });

      // Update cookieHeader with any new cookies from watchRes
      if (watchRes.cookies.length > 0) {
        cookieHeader = [cookieHeader, ...watchRes.cookies.map(c => c.split(';')[0])].filter(Boolean).join('; ');
      }

      const pageIdMatch = watchRes.body.match(/data-pageid=["']([^"']+)["']/i);
      const pingablesMatch = watchRes.body.match(/data-ejpingables=["']([^"']+)["']/i);

      let streamLink = null;

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

        const ajaxRes = await fetchWithCookies(ajaxUrl, {
          method: 'POST',
          body: postBody,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': watchUrl,
            'Cookie': cookieHeader
          }
        });

        try {
          const json = JSON.parse(ajaxRes.body);
          if (json && json.Data && json.Data.EJLinks) {
            const dec = decryptEJ(json.Data.EJLinks);
            if (dec) {
              streamLink = dec.HLSLink || dec.MP4Link;
            }
          }
        } catch (e) {
          console.error('AJAX Parse Error:', ajaxRes.body);
        }
      }

      // Fallback to data attributes if AJAX fails
      if (!streamLink) {
        const hlsMatch = watchRes.body.match(/data-hls-link=["']([^"']+)["']/i);
        const mp4Match = watchRes.body.match(/data-mp4-link=["']([^"']+)["']/i);
        if (hlsMatch) streamLink = hlsMatch[1].replace(/&amp;/g, '&');
        else if (mp4Match) streamLink = mp4Match[1].replace(/&amp;/g, '&');
      }

      if (streamLink) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          title: title,
          lang: lang,
          watchUrl: watchUrl,
          streamUrl: streamLink,
          isHLS: streamLink.includes('.m3u8')
        }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Stream link extraction failed' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Stream proxy
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
  console.log(`Relay active on port ${PORT}`);
});
