/*
 * KM-DEV Stream – Signaling-Server
 *
 * Aufgaben:
 *  1. WebSocket-Signaling (/ws): Raeume anlegen/betreten, SDP/ICE zwischen Host
 *     und Zuschauern weiterreichen. Im P2P-Modus laufen die Mediendaten direkt
 *     zwischen den Teilnehmern.
 *  2. Server-Modus: Der Medien-Server (media/, kmdev-media.exe) haengt sich
 *     ueber /media an und tritt als virtueller Teilnehmer "sfu" auf.
 *  3. ICE-Server-Liste ausgeben, inkl. zeitlich begrenzter TURN-Zugangsdaten
 *     (TURN-REST-Schema, kompatibel zu coturn/eturnal "use-auth-secret").
 *  4. Zuschauen im Browser (/watch).
 *
 * Wer streamen oder die Stream-Liste sehen will, braucht den Zugangsschluessel
 * (accessKey). Zum Zuschauen reicht der Stream-Code.
 *
 * TLS terminiert der vorgeschaltete Reverse-Proxy (Caddy); dieser Prozess
 * lauscht standardmaessig nur auf 127.0.0.1.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const CONFIG_PATH = process.env.STREAM_CONFIG || path.join(__dirname, 'config.json');
const DEFAULTS = {
  host: '127.0.0.1',
  port: 8443,
  stunServers: ['stun:stun.l.google.com:19302'],
  accessKey: '',
  turn: { enabled: false, urls: [], host: '', publicIp: '', listenPort: 3478, secret: '', ttlSeconds: 86400 },
  sfu: { enabled: false, secret: '' },
  maxRoomsPerIp: 5,
  maxViewersHardLimit: 50
};

function loadConfig() {
  let file = {};
  if (fs.existsSync(CONFIG_PATH)) {
    // trimStart entfernt auch ein BOM (U+FEFF), das Windows-Editoren gern davorsetzen.
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').trimStart());
  } else {
    log(`Keine config.json gefunden (${CONFIG_PATH}) – nutze Standardwerte.`);
  }
  const cfg = {
    ...DEFAULTS, ...file,
    turn: { ...DEFAULTS.turn, ...(file.turn || {}) },
    sfu: { ...DEFAULTS.sfu, ...(file.sfu || {}) }
  };
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.HOST) cfg.host = process.env.HOST;
  return cfg;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const cfg = loadConfig();

/* ---------- ICE / TURN ---------- */

// TURN-Adressen: explizit aus turn.urls, sonst aus host bzw. publicIp gebaut.
// Der TURN-Server darf NICHT hinter dem Cloudflare-Proxy liegen (UDP), daher
// standardmaessig direkt die oeffentliche IP.
// Platzhalter aus alten Vorlagen (turn.example.com) werden ignoriert.
const isPlaceholder = s => /example\./.test(String(s));
function turnUrls() {
  const explicit = (cfg.turn.urls || []).filter(u => !isPlaceholder(u));
  if (explicit.length) return explicit;
  const host = [cfg.turn.host, cfg.turn.publicIp].find(h => h && !isPlaceholder(h));
  if (!host) return [];
  const port = cfg.turn.listenPort || 3478;
  return [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`];
}

function iceServersFor(peerId) {
  const list = [];
  if (cfg.stunServers.length) list.push({ urls: cfg.stunServers });
  const urls = turnUrls();
  if (cfg.turn.enabled && cfg.turn.secret && urls.length) {
    const expiry = Math.floor(Date.now() / 1000) + cfg.turn.ttlSeconds;
    const username = `${expiry}:${peerId}`;
    const credential = crypto.createHmac('sha1', cfg.turn.secret).update(username).digest('base64');
    list.push({ urls, username, credential });
  }
  return list;
}

/* ---------- Raeume ---------- */

// Ohne 0/O/1/I/L, damit Codes beim Vorlesen/Abtippen eindeutig sind.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rooms = new Map();   // code -> Room
const clients = new Map(); // ws -> Client

function newCode() {
  for (;;) {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest();
}

function passwordMatches(room, pw) {
  if (!room.passwordHash) return true;
  const given = hashPassword(pw || '');
  return crypto.timingSafeEqual(given, room.passwordHash);
}

// Ohne eingetragenen accessKey ist der Server offen (lokales Testen).
function keyMatches(key) {
  if (!cfg.accessKey) return true;
  return crypto.timingSafeEqual(hashPassword(key || ''), hashPassword(cfg.accessKey));
}

// Bremse gegen Durchprobieren von Stream-Codes/Passwoertern:
// max. 20 Fehlversuche pro Adresse in 10 Minuten.
const failedJoins = new Map(); // ip -> { count, since }
function joinBlocked(ip) {
  const f = failedJoins.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > 10 * 60 * 1000) { failedJoins.delete(ip); return false; }
  return f.count >= 20;
}
function noteFailedJoin(ip) {
  const f = failedJoins.get(ip);
  if (!f || Date.now() - f.since > 10 * 60 * 1000) failedJoins.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}

function clampLimit(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  // 0 = unbegrenzt, aber nie ueber das harte Server-Limit.
  if (n === 0 || n > cfg.maxViewersHardLimit) return cfg.maxViewersHardLimit;
  return n;
}

function cleanTitle(t) {
  return String(t || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
}

function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Gast';
}

function publicRoomList() {
  const out = [];
  for (const [code, r] of rooms) {
    if (r.privacy !== 'public') continue;
    out.push({
      code,
      title: r.title,
      hostName: r.hostName,
      viewers: r.viewers.size,
      viewerLimit: r.viewerLimit,
      hasPassword: !!r.passwordHash,
      since: r.createdAt
    });
  }
  return out.sort((a, b) => b.since - a.since);
}

/* ---------- Senden ---------- */

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendError(ws, code, message, ref) {
  send(ws, { type: 'error', code, message, ref });
}

function peerWs(room, peerId) {
  if (room.hostId === peerId) return room.hostWs;
  return room.viewers.get(peerId)?.ws;
}

/* ---------- Nachrichten ---------- */

function handleHost(ws, c, msg) {
  if (c.room) return sendError(ws, 'busy', 'Bereits in einem Raum.');
  if (!keyMatches(msg.key)) return sendError(ws, 'bad_key', 'Zugangsschlüssel fehlt oder ist falsch.');
  const serverMode = msg.mode === 'server';
  if (serverMode && !mediaWs) return sendError(ws, 'no_sfu', 'Server-Modus ist auf diesem Server nicht verfügbar.');
  let ownRooms = 0;
  for (const r of rooms.values()) if (r.hostIp === c.ip) ownRooms++;
  if (ownRooms >= cfg.maxRoomsPerIp) return sendError(ws, 'too_many_rooms', 'Zu viele aktive Streams von dieser Adresse.');

  const code = newCode();
  const room = {
    hostId: c.id,
    hostWs: ws,
    hostIp: c.ip,
    hostName: cleanName(msg.name),
    title: cleanTitle(msg.title),
    privacy: ['public', 'contacts', 'private'].includes(msg.privacy) ? msg.privacy : 'private',
    passwordHash: msg.password ? hashPassword(msg.password) : null,
    viewerLimit: clampLimit(msg.viewerLimit),
    viewers: new Map(), // peerId -> { ws, name }
    mode: serverMode ? 'server' : 'p2p',
    createdAt: Date.now()
  };
  rooms.set(code, room);
  c.room = code;
  c.role = 'host';
  c.name = room.hostName;
  log(`Raum ${code} erstellt von ${c.ip} (${room.mode}, ${room.privacy}, Limit ${room.viewerLimit})`);
  send(ws, {
    type: 'hosted', room: code, peerId: c.id, mode: room.mode,
    iceServers: iceServersFor(c.id), viewerLimit: room.viewerLimit
  });
}

function handleHostUpdate(ws, c, msg) {
  const room = c.role === 'host' && rooms.get(c.room);
  if (!room) return sendError(ws, 'not_host', 'Kein eigener Raum.');
  if ('title' in msg) room.title = cleanTitle(msg.title);
  if ('privacy' in msg && ['public', 'contacts', 'private'].includes(msg.privacy)) room.privacy = msg.privacy;
  if ('password' in msg) room.passwordHash = msg.password ? hashPassword(msg.password) : null;
  if ('viewerLimit' in msg) room.viewerLimit = clampLimit(msg.viewerLimit);
  send(ws, { type: 'host-updated', viewerLimit: room.viewerLimit });
}

function handleJoin(ws, c, msg) {
  if (c.room) return sendError(ws, 'busy', 'Bereits in einem Raum.');
  if (joinBlocked(c.ip)) return sendError(ws, 'rate_limited', 'Zu viele Fehlversuche. Bitte in ein paar Minuten erneut versuchen.');
  const code = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const room = rooms.get(code);
  if (!room) { noteFailedJoin(c.ip); return sendError(ws, 'not_found', 'Stream nicht gefunden.'); }
  if (!passwordMatches(room, msg.password)) { noteFailedJoin(c.ip); return sendError(ws, 'bad_password', 'Falsches Passwort.'); }
  if (room.viewers.size >= room.viewerLimit) return sendError(ws, 'full', 'Zuschauerbegrenzung erreicht.');

  c.room = code;
  c.role = 'viewer';
  c.name = cleanName(msg.name);
  room.viewers.set(c.id, { ws, name: c.name });
  log(`${c.name} (${c.ip}) schaut Raum ${code} (${room.viewers.size}/${room.viewerLimit})`);

  send(ws, {
    type: 'joined',
    room: code,
    peerId: c.id,
    // Im Server-Modus ist die SFU der Gegenueber, nicht der Host.
    hostId: room.mode === 'server' ? SFU_ID : room.hostId,
    hostName: room.hostName,
    title: room.title,
    mode: room.mode,
    iceServers: iceServersFor(c.id)
  });
  send(room.hostWs, { type: 'viewer-joined', peerId: c.id, name: c.name, viewers: room.viewers.size });
  if (room.mode === 'server') toMedia({ type: 'viewer-join', room: code, peer: c.id });
}

function handleSignal(ws, c, msg) {
  const room = rooms.get(c.room);
  if (!room) return;
  if (room.mode === 'server') {
    // Server-Modus: Host und Zuschauer sprechen nur mit der SFU.
    if (msg.to === SFU_ID) toMedia({ type: 'signal', room: c.room, peer: c.id, role: c.role, data: msg.data });
    return;
  }
  // Signale nur zwischen Host und Zuschauern desselben Raums – Zuschauer
  // untereinander duerfen sich nicht direkt adressieren.
  if (c.role === 'viewer' && msg.to !== room.hostId) return;
  const target = peerWs(room, msg.to);
  if (!target) return;
  send(target, { type: 'signal', from: c.id, data: msg.data });
}

function handleKick(ws, c, msg) {
  const room = c.role === 'host' && rooms.get(c.room);
  if (!room) return;
  const v = room.viewers.get(msg.peerId);
  if (!v) return;
  send(v.ws, { type: 'kicked' });
  leave(v.ws);
}

function leave(ws) {
  const c = clients.get(ws);
  if (!c || !c.room) return;
  const room = rooms.get(c.room);
  const code = c.room;
  c.room = null;
  const role = c.role;
  c.role = null;
  if (!room) return;

  if (role === 'host') {
    for (const v of room.viewers.values()) {
      send(v.ws, { type: 'host-left' });
      const vc = clients.get(v.ws);
      if (vc) { vc.room = null; vc.role = null; }
    }
    rooms.delete(code);
    if (room.mode === 'server') toMedia({ type: 'room-close', room: code });
    log(`Raum ${code} beendet`);
  } else if (role === 'viewer') {
    room.viewers.delete(c.id);
    send(room.hostWs, { type: 'viewer-left', peerId: c.id, viewers: room.viewers.size });
    if (room.mode === 'server') toMedia({ type: 'peer-leave', room: code, peer: c.id });
  }
}

/* ---------- Medien-Server (SFU) ---------- */

const SFU_ID = 'sfu';
let mediaWs = null;

function toMedia(msg) {
  send(mediaWs, msg);
}

// Nachricht der SFU an einen Teilnehmer weiterreichen.
function fromMedia(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type !== 'signal') return;
  const room = rooms.get(msg.room);
  if (!room || room.mode !== 'server') return;
  send(peerWs(room, msg.peer), { type: 'signal', from: SFU_ID, data: msg.data });
}

function onMediaConnection(ws) {
  if (mediaWs) mediaWs.terminate();
  mediaWs = ws;
  log('Medien-Server (SFU) verbunden');
  ws.on('message', fromMedia);
  ws.on('close', () => {
    if (mediaWs !== ws) return;
    mediaWs = null;
    log('Medien-Server (SFU) getrennt');
    // Die SFU hat alle Verbindungen verloren -> Server-Modus-Raeume beenden,
    // damit Host und Zuschauer nicht vor einem schwarzen Bild sitzen.
    for (const [code, room] of rooms) {
      if (room.mode !== 'server') continue;
      send(room.hostWs, { type: 'sfu-lost' });
      leave(room.hostWs);
      log(`Raum ${code} beendet (SFU getrennt)`);
    }
  });
}

function mediaAuthorized(req) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  // Ueber Caddy weitergereichte Anfragen kommen auch von 127.0.0.1, tragen
  // aber Proxy-Header -> von aussen ist /media nie erreichbar.
  const proxied = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'];
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  if (!local || proxied || !cfg.sfu.enabled || String(cfg.sfu.secret).length < 16) return false;
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(String(cfg.sfu.secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

const handlers = {
  host: handleHost,
  'host-update': handleHostUpdate,
  join: handleJoin,
  signal: handleSignal,
  kick: handleKick,
  leave: (ws) => leave(ws),
  list: (ws, c, msg) => {
    if (!keyMatches(msg.key)) return sendError(ws, 'bad_key', 'Zugangsschlüssel fehlt oder ist falsch.');
    send(ws, { type: 'rooms', rooms: publicRoomList() });
  },
  // Was kann dieser Server? (fuer die App-Einstellungen)
  info: (ws, c, msg) => send(ws, { type: 'info', keyOk: keyMatches(msg.key), sfu: !!mediaWs }),
  ping: (ws) => send(ws, { type: 'pong' })
};

/* ---------- HTTP (Health) ---------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size, sfu: !!mediaWs }));
    return;
  }
  if (serveWeb(url.pathname, res)) return;
  res.writeHead(404).end('Not found');
});

/* ---------- Zuschauen im Browser (/watch) ---------- */

// Kleine feste Dateiliste statt Verzeichnis-Freigabe: rtc.js kommt direkt aus
// der App (renderer/), damit Browser und App dieselbe WebRTC-Logik nutzen.
const WEB_FILES = {
  '/watch': ['web/watch.html', 'text/html; charset=utf-8'],
  '/watch/': ['web/watch.html', 'text/html; charset=utf-8'],
  '/watch/watch.js': ['web/watch.js', 'text/javascript; charset=utf-8'],
  '/watch/watch.css': ['web/watch.css', 'text/css; charset=utf-8'],
  '/watch/rtc.js': ['../renderer/rtc.js', 'text/javascript; charset=utf-8'],
  '/watch/invite.js': ['../renderer/invite.js', 'text/javascript; charset=utf-8']
};

function serveWeb(pathname, res) {
  const entry = WEB_FILES[pathname];
  if (!entry) return false;
  fs.readFile(path.join(__dirname, entry[0]), (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src blob: mediastream:; img-src 'self' data:; frame-ancestors 'none'"
    });
    res.end(data);
  });
  return true;
}

/* ---------- WebSocket ---------- */

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const mediaWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/media') {
    if (!mediaAuthorized(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    mediaWss.handleUpgrade(req, socket, head, onMediaConnection);
    return;
  }
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  // Hinter Cloudflare -> Caddy steht die echte Adresse in CF-Connecting-IP
  // (X-Forwarded-For enthaelt sonst nur die Cloudflare-Edge). Den Headern
  // vertrauen ist ok, weil dieser Prozess nur auf 127.0.0.1 lauscht.
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const c = { id: newId(), ip: cf || fwd || req.socket.remoteAddress, room: null, role: null, name: '', alive: true, bucket: 0 };
  clients.set(ws, c);
  send(ws, { type: 'welcome', peerId: c.id, serverTime: Date.now() });

  ws.on('pong', () => { c.alive = true; });

  ws.on('message', (raw) => {
    // Grobe Flutbremse: max. 100 Nachrichten pro Sekunde (ICE-Kandidaten
    // kommen beim Verbindungsaufbau in Schueben).
    if (++c.bucket > 100) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const h = msg && handlers[msg.type];
    if (h) {
      try { h(ws, c, msg); } catch (e) { log('Handler-Fehler', msg.type, e); }
    }
  });

  ws.on('close', () => {
    leave(ws);
    clients.delete(ws);
  });
});

setInterval(() => {
  for (const c of clients.values()) c.bucket = 0;
}, 1000);

// Tote Verbindungen (Standby, WLAN weg) aufraeumen, damit Raeume nicht
// als Leichen in der Liste haengen bleiben.
setInterval(() => {
  for (const [ws, c] of clients) {
    if (!c.alive) { ws.terminate(); continue; }
    c.alive = false;
    ws.ping();
  }
}, 20000);

server.on('error', (err) => {
  if (err.code === 'EACCES') {
    log(`Port ${cfg.port} ist gesperrt (unter Windows meist von Hyper-V/WSL reserviert, ` +
      `siehe "netsh interface ipv4 show excludedportrange protocol=tcp"). ` +
      `Anderen Port in config.json eintragen oder install-server.ps1 erneut ausfuehren.`);
  } else if (err.code === 'EADDRINUSE') {
    log(`Port ${cfg.port} wird bereits von einem anderen Programm benutzt. Anderen Port in config.json eintragen.`);
  } else {
    log('Server-Fehler', err);
  }
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  log(`KM-DEV Stream Server laeuft auf http://${cfg.host}:${cfg.port} (WS: /ws)`);
});
