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
    const sliced = encryptedData.slice(0, 10) + encryptedData.slice(-1) + encryptedData.slice(12, -1);
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

  // Robust stream resolver with PingOutcome fallback
  if (parsed.pathname === '/resolve') {
    const title = parsed.query.title;
    const lang = parsed.query.lang || 'tamil';
    if (!title) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing title' }));
    }

    try {
      const searchUrl = `https://${EINTHUSAN_HOST}/movie/results/?lang=${encodeURIComponent(lang)}&query=${encodeURIComponent(title)}`;
      const searchRes = await fetchUrl(searchUrl);
      
      const watchMatch = searchRes.body.match(/href=["'](\/movie\/watch\/([^"'/]+)\/[^"']*)["']/i);
      if (!watchMatch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Movie not found on Einthusan' }));
      }

      const watchPath = watchMatch[1];
      const videoId = watchMatch[2];
      const watchUrl = `https://${EINTHUSAN_HOST}${watchPath}`;
      const watchRes = await fetchUrl(watchUrl, { headers: { Referer: searchUrl } });

      const pageIdMatch = watchRes.body.match(/data-pageid=["']([^"']+)["']/i);
      const pingablesMatch = watchRes.body.match(/data-ejpingables=["']([^"']+)["']/i);
      const hlsMatch = watchRes.body.match(/data-hls-link=["']([^"']+)["']/i);
      const mp4Match = watchRes.body.match(/data-mp4-link=["']([^"']+)["']/i);

      let directStream = (hlsMatch ? hlsMatch[1] : (mp4Match ? mp4Match[1] : null));
      let ejStream = null;

      if (pageIdMatch && pingablesMatch) {
        try {
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

          const json = JSON.parse(ajaxRes.body);
          if (json && json.Data && json.Data.EJLinks) {
            const dec = decryptEJ(json.Data.EJLinks);
            if (dec) {
              ejStream = dec.HLSLink || dec.MP4Link;
            }
          }
        } catch (ajaxErr) {
          console.error('AJAX PingOutcome error:', ajaxErr.message);
        }
      }

      const finalStream = ejStream || (directStream ? directStream.replace(/&amp;/g, '&') : null);

      if (finalStream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          title: title,
          lang: lang,
          watchUrl: watchUrl,
          streamUrl: finalStream,
          isHLS: finalStream.includes('.m3u8')
        }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Stream extraction failed' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Relay active on port ${PORT}`);
});
