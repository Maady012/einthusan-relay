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

  if (parsed.pathname === '/debug-login') {
    try {
      const loginPage = await fetchWithCookies(`https://${EINTHUSAN_HOST}/login/`);
      const pageIdMatch = loginPage.body.match(/data-pageid=["']([^"']+)["']/i);
      let cookieJar = loginPage.cookies.map(c => c.split(';')[0]).join('; ');

      const payload = new URLSearchParams({
        xEvent: 'Login',
        xJson: JSON.stringify({ Email: ACCOUNT_EMAIL, Password: ACCOUNT_PASS }),
        tabID: 'vwmSPyo0giMK9nETr0vMMrE/dIBvZQ6a11v+i2kVk6/t7UCLFWORSxePRTDTpRTAeuu/D/9t32a7lO3aJNo7EA==25',
        'gorilla.csrf.Token': pageIdMatch ? pageIdMatch[1] : ''
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

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        hasPageId: Boolean(pageIdMatch),
        cookiesSent: cookieJar,
        ajaxStatus: loginRes.status,
        ajaxHeaders: loginRes.headers,
        ajaxBody: loginRes.body
      }));
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
