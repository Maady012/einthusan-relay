const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');
const querystring = require('querystring');

const PORT = process.env.PORT || 8080;
const EINTHUSAN_HOST = 'einthusan.tv';

const ACCOUNT_EMAIL = process.env.EINTHUSAN_EMAIL || 'trickzfru@gmail.com';
const ACCOUNT_PASS = process.env.EINTHUSAN_PASSWORD || 'Maddy0124';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
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
    req.setTimeout(15000, () => { req.destroy(new Error('Timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

function parseCookieHeader(cookieArray) {
  return cookieArray.map(c => c.split(';')[0]).join('; ');
}

// Global cached session
let cachedSessionCookies = null;
let cachedSessionTime = 0;

async function getAuthenticatedSession() {
  const now = Date.now();
  if (cachedSessionCookies && (now - cachedSessionTime < 30 * 60 * 1000)) {
    return cachedSessionCookies;
  }

  console.log('[Auth] Initiating login handshake with Einthusan...');
  // 1. GET /login/ to grab cookies and data-pageid
  const loginGet = await fetchWithCookies(`https://${EINTHUSAN_HOST}/login/`);
  const initialCookies = parseCookieHeader(loginGet.cookies);

  // Extract data-pageid
  const match = loginGet.body.match(/data-pageid=["']([^"']+)["']/);
  if (!match) {
    throw new Error('Could not find data-pageid on /login/ page');
  }

  // HTML entity decode
  let pageId = match[1]
    .replace(/&#43;/g, '+')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  const tabId = pageId + Math.floor(1000 * Math.random());

  const postPayload = querystring.stringify({
    xEvent: 'Login',
    xJson: JSON.stringify({ Email: ACCOUNT_EMAIL, Password: ACCOUNT_PASS }),
    arcVersion: '12',
    appVersion: '365',
    tabID: tabId,
    'gorilla.csrf.Token': pageId
  });

  const loginPost = await fetchWithCookies(`https://${EINTHUSAN_HOST}/ajax/login/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Cookie': initialCookies,
      'Referer': `https://${EINTHUSAN_HOST}/login/`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: postPayload
  });

  console.log('[Auth] Login response status:', loginPost.status, 'body:', loginPost.body);

  // Merge cookies
  const postCookies = parseCookieHeader(loginPost.cookies);
  const combinedCookies = [initialCookies, postCookies].filter(Boolean).join('; ');

  cachedSessionCookies = combinedCookies;
  cachedSessionTime = now;

  return { cookies: combinedCookies, response: loginPost.body, status: loginPost.status };
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (parsed.pathname === '/login-test') {
    try {
      const authResult = await getAuthenticatedSession();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, authResult }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: e.message, stack: e.stack }));
    }
  }

  if (parsed.pathname === '/search') {
    const query = parsed.query.query || '';
    const lang = parsed.query.lang || 'tamil';
    try {
      const searchUrl = `https://${EINTHUSAN_HOST}/movie/results/?lang=${lang}&query=${encodeURIComponent(query)}`;
      const result = await fetchWithCookies(searchUrl);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(result.body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (parsed.pathname === '/watch-page') {
    const path = parsed.query.path;
    try {
      const auth = await getAuthenticatedSession();
      const movieUrl = `https://${EINTHUSAN_HOST}${path}`;
      const result = await fetchWithCookies(movieUrl, {
        headers: {
          'Cookie': auth.cookies || auth
        }
      });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(result.body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // General reverse proxy for HLS / MP4 chunks
  if (parsed.pathname === '/proxy') {
    const targetUrl = parsed.query.url;
    if (!targetUrl) {
      res.writeHead(400);
      return res.end('Missing url param');
    }
    try {
      const parsedTarget = new URL(targetUrl);
      const isHttps = parsedTarget.protocol === 'https:';
      const client = isHttps ? https : http;

      const proxyReq = client.request(parsedTarget, {
        method: req.method,
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Referer': `https://${EINTHUSAN_HOST}/`,
          'Range': req.headers['range'] || ''
        },
        rejectUnauthorized: false
      }, (proxyRes) => {
        const responseHeaders = { ...proxyRes.headers, 'Access-Control-Allow-Origin': '*' };
        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
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

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'einthusan-relay-live', version: '2.0.0' }));
});

server.listen(PORT, () => {
  console.log(`Einthusan relay server running on port ${PORT}`);
});
