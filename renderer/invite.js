/*
 * Einladungen und Links (App und Browser-Seite nutzen dieses Modul).
 *
 *   kmdev-stream://setup/<daten>  richtet Server + Zugangsschluessel ein
 *   kmdev-stream://join/<daten>   oeffnet einen Stream in der App
 *   https://<domain>/watch#CODE   Stream im Browser (oder "In App oeffnen")
 *
 * <daten> ist base64url-kodiertes JSON. Das ist KEINE Verschluesselung: Wer
 * eine Setup-Einladung hat, kann den Server nutzen.
 */

export const SCHEME = 'kmdev-stream';

function encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

function validServer(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'wss:' || u.protocol === 'ws:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function cleanRoom(r) {
  return String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

export function setupInvite(server, key) {
  return `${SCHEME}://setup/${encode({ s: server, k: key || '' })}`;
}

export function joinLink(server, room) {
  return `${SCHEME}://join/${encode({ s: server, r: room })}`;
}

// wss://host/ws -> https://host/watch#CODE
export function watchUrl(server, room) {
  const u = new URL(server);
  u.protocol = u.protocol === 'ws:' ? 'http:' : 'https:';
  u.pathname = '/watch';
  u.search = '';
  u.hash = room;
  return u.toString();
}

// Liefert { kind: 'setup', server, key } | { kind: 'join', server, room } | null
export function parseInvite(text) {
  const t = String(text || '').trim();
  const m = new RegExp(`^${SCHEME}://(setup|join)/([A-Za-z0-9_-]+)/?$`).exec(t);
  if (m) {
    let d;
    try { d = decode(m[2]); } catch { return null; }
    const server = validServer(d.s);
    if (!server) return null;
    if (m[1] === 'setup') return { kind: 'setup', server, key: String(d.k || '') };
    const room = cleanRoom(d.r);
    return room ? { kind: 'join', server, room } : null;
  }
  // Auch einen kopierten Browser-Link akzeptieren.
  try {
    const u = new URL(t);
    if ((u.protocol === 'https:' || u.protocol === 'http:') && u.pathname.replace(/\/$/, '') === '/watch') {
      const room = cleanRoom(u.hash.slice(1));
      if (!room) return null;
      const server = `${u.protocol === 'http:' ? 'ws:' : 'wss:'}//${u.host}/ws`;
      return { kind: 'join', server, room };
    }
  } catch { /* kein Link */ }
  return null;
}
