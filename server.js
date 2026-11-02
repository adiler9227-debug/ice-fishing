// Сервер «Ледяной рыбалки»: раздаёт игру и хранит сохранения игроков в файлах.
// Без внешних зависимостей — нужен только Node.js.
// Переменные: PORT (Railway задаёт сам), DATA_DIR (необязательно; на Railway берётся путь подключённого Volume).
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const PORT = process.env.PORT || 3001;

function pickDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return process.env.RAILWAY_VOLUME_MOUNT_PATH; // Railway: подключённый диск (Volume)
  for (const d of ['/var/lib/ice-fishing', path.join(__dirname, 'data')]) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) {}
  }
  return path.join(__dirname, 'data');
}
const DATA = pickDataDir();
const PLAYERS = path.join(DATA, 'players');
fs.mkdirSync(PLAYERS, { recursive: true });
const CODES_FILE = path.join(DATA, 'codes.json');
const NAMES_FILE = path.join(DATA, 'names.json');
let names = {}; // имя (в нижнем регистре) -> { id, salt, hash }
try { names = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')); } catch (e) { names = {}; }
function saveNames() { writeAtomic(NAMES_FILE, JSON.stringify(names)); }
const nameKey = n => String(n || '').trim().replace(/\s+/g, ' ').toLowerCase();
const cleanName = n => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 20);
const pinHash = (salt, pin) => crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
const fails = new Map(); // имя -> [время неудачных попыток]

// ---------- хранилище ----------
let codes = {}; // код игрока -> id
try { codes = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')); } catch (e) { codes = {}; }
function writeAtomic(file, text) { const tmp = file + '.tmp' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
function saveCodes() { writeAtomic(CODES_FILE, JSON.stringify(codes)); }
const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const pfile = id => path.join(PLAYERS, id + '.json');
function readPlayer(id) {
  if (!validId(id)) return null;
  for (const f of [pfile(id), pfile(id) + '.bak']) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {} }
  return null;
}
function writePlayer(id, p) {
  const f = pfile(id);
  try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak'); } catch (e) {}
  writeAtomic(f, JSON.stringify(p));
}
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { let c; do { c = ''; const b = crypto.randomBytes(6); for (let i = 0; i < 6; i++) c += ALPH[b[i] % ALPH.length]; } while (codes[c]); return c; }

// ---------- простая защита от перебора кодов ----------
const hits = new Map();
function limited(ip, max) { const now = Date.now(); const h = (hits.get(ip) || []).filter(t => now - t < 60000); h.push(now); hits.set(ip, h); return h.length > max; }
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 60000);

// ---------- файлы игры (gzip + ETag) ----------
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/three.module.min.js': ['three.module.min.js', 'text/javascript; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'], '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'],
};
const CACHE = {};
function getFile(name, cb) {
  const fp = path.join(__dirname, name);
  fs.stat(fp, (e, st) => {
    if (e) return cb(e); const c = CACHE[name]; if (c && c.m === st.mtimeMs && c.s === st.size) return cb(null, c);
    fs.readFile(fp, (e2, d) => { if (e2) return cb(e2); zlib.gzip(d, { level: 9 }, (e3, gz) => { CACHE[name] = { m: st.mtimeMs, s: st.size, d, gz: e3 ? null : gz, etag: '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"' }; cb(null, CACHE[name]); }); });
  });
}
function sendJSON(r, code, obj) { const b = JSON.stringify(obj); r.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) }); r.end(b); }
function readBody(q, max, cb) { let size = 0, chunks = [], done = false; q.on('data', c => { size += c.length; if (size > max) { done = true; cb(new Error('too big')); q.destroy(); } else chunks.push(c); }); q.on('end', () => { if (!done) { try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { cb(e); } } }); }

const server = http.createServer((q, r) => {
  const url = new URL(q.url || '/', 'http://x'); const p = url.pathname;
  const ip = (q.headers['x-forwarded-for'] || '').split(',')[0].trim() || q.socket.remoteAddress || '?';
  if (p.startsWith('/api/')) {
    if (p === '/api/ping') return sendJSON(r, 200, { ok: true, game: 'ice-fishing' });
    if (p === '/api/new' && q.method === 'POST') {
      if (limited(ip + ':new', 20)) return sendJSON(r, 429, { error: 'slow down' });
      const id = crypto.randomBytes(16).toString('hex'), code = newCode();
      writePlayer(id, { code, created: Date.now(), t: 0, save: null }); codes[code] = id; saveCodes();
      return sendJSON(r, 200, { id, code });
    }
    if (p === '/api/load' && q.method === 'GET') {
      const id = url.searchParams.get('id'); const pl = readPlayer(id);
      if (!pl) return sendJSON(r, 404, { error: 'not found' });
      return sendJSON(r, 200, { id, code: pl.code, name: pl.name || null, save: pl.save, t: pl.t });
    }
    if (p === '/api/save' && q.method === 'POST') {
      return readBody(q, 256 * 1024, (e, b) => {
        if (e || !b || !validId(b.id) || typeof b.save !== 'string') return sendJSON(r, 400, { error: 'bad request' });
        try { JSON.parse(b.save); } catch (e2) { return sendJSON(r, 400, { error: 'bad save' }); }
        const pl = readPlayer(b.id); if (!pl) return sendJSON(r, 404, { error: 'not found' });
        pl.save = b.save; pl.t = Date.now(); writePlayer(b.id, pl); sendJSON(r, 200, { ok: true, t: pl.t });
      });
    }
    if (p === '/api/restore' && q.method === 'POST') {
      if (limited(ip + ':restore', 10)) return sendJSON(r, 429, { error: 'slow down' });
      return readBody(q, 1024, (e, b) => {
        const code = String((b && b.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const id = codes[code]; const pl = id && readPlayer(id);
        if (!pl) return sendJSON(r, 404, { error: 'not found' });
        sendJSON(r, 200, { id, code: pl.code, save: pl.save, t: pl.t });
      });
    }
    if (p === '/api/claim' && q.method === 'POST') { // привязать имя + PIN к игроку
      return readBody(q, 2048, (e, b) => {
        if (e || !b || !validId(b.id)) return sendJSON(r, 400, { error: 'bad request' });
        const name = cleanName(b.name), key = nameKey(name), pin = String(b.pin || '');
        if (name.length < 2) return sendJSON(r, 400, { error: 'name' });
        if (!/^[0-9]{4}$/.test(pin)) return sendJSON(r, 400, { error: 'pin' });
        const pl = readPlayer(b.id); if (!pl) return sendJSON(r, 404, { error: 'not found' });
        if (names[key] && names[key].id !== b.id) return sendJSON(r, 409, { error: 'taken' });
        if (pl.name && nameKey(pl.name) !== key && names[nameKey(pl.name)] && names[nameKey(pl.name)].id === b.id) delete names[nameKey(pl.name)];
        const salt = crypto.randomBytes(8).toString('hex');
        names[key] = { id: b.id, salt, hash: pinHash(salt, pin) }; saveNames();
        pl.name = name; writePlayer(b.id, pl);
        sendJSON(r, 200, { ok: true, name });
      });
    }
    if (p === '/api/login' && q.method === 'POST') { // войти по имени + PIN
      if (limited(ip + ':login', 12)) return sendJSON(r, 429, { error: 'slow down' });
      return readBody(q, 2048, (e, b) => {
        const key = nameKey(b && b.name), pin = String((b && b.pin) || ''), rec = names[key];
        const now = Date.now(), f = (fails.get(key) || []).filter(t => now - t < 3600000);
        if (f.length >= 20) return sendJSON(r, 429, { error: 'locked' });
        if (!rec || rec.hash !== pinHash(rec.salt, pin)) { f.push(now); fails.set(key, f); return sendJSON(r, 404, { error: 'not found' }); }
        const pl = readPlayer(rec.id); if (!pl) return sendJSON(r, 404, { error: 'not found' });
        sendJSON(r, 200, { id: rec.id, code: pl.code, name: pl.name, save: pl.save, t: pl.t });
      });
    }
    return sendJSON(r, 404, { error: 'unknown' });
  }
  const f = FILES[p]; if (!f) { r.writeHead(404); return r.end('not found'); }
  getFile(f[0], (e, c) => {
    if (e) { r.writeHead(404); return r.end('not found'); }
    if (q.headers['if-none-match'] === c.etag) { r.writeHead(304, { ETag: c.etag, 'Cache-Control': 'no-cache' }); return r.end(); }
    const gz = c.gz && /\bgzip\b/.test(q.headers['accept-encoding'] || ''), body = gz ? c.gz : c.d;
    const h = { 'Content-Type': f[1], 'Cache-Control': 'no-cache', ETag: c.etag, 'Content-Length': body.length, Vary: 'Accept-Encoding' }; if (gz) h['Content-Encoding'] = 'gzip';
    r.writeHead(200, h); r.end(body);
  });
});
['index.html', 'three.module.min.js'].forEach(n => getFile(n, () => {}));
server.listen(PORT, '0.0.0.0', () => console.log('ice-fishing listening', PORT, 'data:', DATA));
