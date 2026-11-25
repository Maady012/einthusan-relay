const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;
const EINTHUSAN_HOST = 'einthusan.tv';

const ACCOUNT_EMAIL = process.env.EINTHUSAN_EMAIL || 'trickzfru@gmail.com';
const ACCOUNT_PASS = process.env.EINTHUSAN_PASSWORD || 'Maddy0124';

let sessionCookie = '';
let sessionExpires = 0;

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
    req.setTimeout(10000, () => { req.destroy(new Error('Timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

async function ensureLogin() {
  if (sessionCookie && Date.now() < sessionExpires) {
    return sessionCookie;
  }

  console.log('[Auth] Logging into Einthusan with account:', ACCOUNT_EMAIL);
  try {
    const loginPage = await fetchWithCookies(`https://${EINTHUSAN_HOST}/login/`);
    const pageIdMatch = loginPage.body.match(/data-pageid=["']([^"']+)["']/i);
    if (!pageIdMatch) {
      console.error('[Auth] CSRF data-pageid not found on login page');
      return '';
    }

    let cookieJar = loginPage.cookies.map(c => c.split(';')[0]).join('; ');

    const payload = new URLSearchParams({
      xEvent: 'Login',
      xJson: JSON.stringify({ Email: ACCOUNT_EMAIL, Password: ACCOUNT_PASS }),
      tabID: 'vwmSPyo0giMK9nETr0vMMrE/dIBvZQ6a11v+i2kVk6/t7UCLFWORSxePRTDTpRTAeuu/D/9t32a7lO3aJNo7EA==25',
      'gorilla.csrf.Token': pageIdMatch[1]
    }).toString();

    const loginRes = await fetchWithCookies(`https://${EINTHUSAN_HOST}/ajax/login/`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': `https://${EINTHUSAN_HOST}`,
        'Referer': `https://${EINTHUSAN_HOST}/login/`,
        'Cookie': cookieJar
      }
    });

    if (loginRes.cookies.length > 0) {
      cookieJar = [cookieJar, ...loginRes.cookies.map(c => c.split(';')[0])].filter(Boolean).join('; ');
    }

    let loginData;
    try {
      loginData = JSON.parse(loginRes.body);
    } catch (e) {
      console.error('[Auth] Failed to parse login response:', loginRes.body);
      return '';
    }

    if (loginData.Event === 'redirect' || loginData.Event === 'success') {
      console.log('[Auth] Login successful! Event:', loginData.Event, 'Data:', loginData.Data);
      sessionCookie = cookieJar;
      sessionExpires = Date.now() + (6 * 3600 * 1000); // 6 hours
      return sessionCookie;
    } else {
      console.error('[Auth] Login response indicates failure:', loginData);
      return '';
    }
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    return '';
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
    return res.end(JSON.stringify({ status: 'ok', service: 'einthusan-relay', hasSession: Boolean(sessionCookie) }));
  }

  // Auth test endpoint
  if (parsed.pathname === '/login-test') {
    const cookie = await ensureLogin();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: Boolean(cookie),
      hasSession: Boolean(sessionCookie)
    }));
  }

  // Stream Resolver
  if (parsed.pathname === '/resolve') {
    const title = parsed.query.title;
    const lang = parsed.query.lang || 'tamil';
    if (!title) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing title' }));
    }

    try {
      const cookie = await ensureLogin();
      const searchUrl = `https://${EINTHUSAN_HOST}/movie/results/?lang=${encodeURIComponent(lang)}&query=${encodeURIComponent(title)}`;
      const searchRes = await fetchWithCookies(searchUrl, {
        headers: cookie ? { Cookie: cookie } : {}
      });
      
      const watchMatch = searchRes.body.match(/href=["'](\/movie\/watch\/([^"'/]+)\/[^"']*)["']/i);
      if (!watchMatch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Movie not found on Einthusan' }));
      }

      const watchPath = watchMatch[1];
      const videoId = watchMatch[2];
      const watchUrl = `https://${EINTHUSAN_HOST}${watchPath}`;
      
      const watchRes = await fetchWithCookies(watchUrl, {
        headers: {
          Referer: searchUrl,
          ...(cookie ? { Cookie: cookie } : {})
        }
      });

      const hlsMatch = watchRes.body.match(/data-hls-link=["']([^"']+)["']/i);
      const mp4Match = watchRes.body.match(/data-mp4-link=["']([^"']+)["']/i);
      const isPremiumMatch = watchRes.body.match(/data-premium=["']([^"']+)["']/i);

      let streamLink = (hlsMatch ? hlsMatch[1] : (mp4Match ? mp4Match[1] : null));

      if (streamLink) {
        streamLink = streamLink.replace(/&amp;/g, '&');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          title: title,
          lang: lang,
          videoId: videoId,
          watchUrl: watchUrl,
          streamUrl: streamLink,
          isHLS: Boolean(hlsMatch),
          isPremium: isPremiumMatch ? isPremiumMatch[1] : 'unknown',
          authenticated: Boolean(cookie)
        }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Stream link extraction failed' }));
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
  console.log(`Relay active on port ${PORT}`);
});
