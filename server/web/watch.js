// Zuschauen im Browser. Nutzt dieselbe WebRTC-Logik wie die App (rtc.js),
// funktioniert im P2P- wie im Server-Modus.
import { Signaling, ViewerSession } from '/watch/rtc.js';
import { joinLink } from '/watch/invite.js';
import { playEndChime } from '/watch/sounds.js';

const $ = (sel) => document.querySelector(sel);
const SERVER = `${location.protocol === 'http:' ? 'ws:' : 'wss:'}//${location.host}/ws`;

let current = null; // { sig, session }

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key) || '';
    localStorage.setItem(key, value);
  } catch { /* privates Fenster */ }
  return '';
}

function codeFromHash() {
  return decodeURIComponent(location.hash.slice(1)).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function updateAppLink() {
  const code = $('#inpCode').value.trim().toUpperCase();
  const link = $('#lnkApp');
  link.hidden = !code;
  link.href = code ? joinLink(SERVER, code) : '#';
}

async function watch() {
  if (current) return;
  const code = $('#inpCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) { $('#error').textContent = 'Bitte den Stream-Code eingeben.'; return; }
  const name = $('#inpName').value.trim();
  storage('kmdev-name', name);
  $('#error').textContent = '';
  $('#btnWatch').disabled = true;

  const sig = new Signaling(SERVER);
  try {
    await sig.connect();
    const res = await sig.request({ type: 'join', room: code, password: $('#inpPassword').value, name: name || 'Gast (Browser)' }, 'joined');
    const session = new ViewerSession({ signaling: sig, iceServers: res.iceServers, hostId: res.hostId });
    current = { sig, session };
    history.replaceState(null, '', `#${code}`);

    $('#lobby').hidden = true;
    $('#player').hidden = false;
    $('#title').textContent = `${res.title || 'Stream'} – ${res.hostName}`;
    document.title = `${res.title || 'Stream'} – KM-DEV Stream`;
    const video = $('#video');
    video.volume = Number($('#volume').value);

    session.addEventListener('track', (e) => {
      video.srcObject = e.detail;
      // Der Klick auf "Ansehen" erlaubt Wiedergabe mit Ton; falls der Browser
      // trotzdem blockiert, stumm starten und Hinweis zeigen.
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
        overlay('Klicke ins Bild, um den Ton einzuschalten.', true);
      });
    });
    session.addEventListener('state', (e) => {
      const st = e.detail;
      if (st === 'connected') overlay(null);
      else if (st === 'failed') overlay('Verbindung fehlgeschlagen (Firewall/NAT). Probier es in der App.');
      else if (st === 'disconnected') overlay('Verbindung unterbrochen…');
    });
    session.addEventListener('stats', (e) => {
      const s = e.detail;
      $('#stats').textContent = [
        s.width ? `${s.width}×${s.height}` : null,
        s.fps != null ? `${s.fps} fps` : null,
        s.kbps != null ? `${(s.kbps / 1000).toFixed(1)} Mbit/s` : null,
        s.codec || null
      ].filter(Boolean).join(' · ');
    });
    sig.on('audience', (m) => {
      const names = m.names || [];
      const el = $('#audience');
      el.textContent = names.length ? `👁 ${names.length} · ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' …' : ''}` : '';
      el.title = names.length ? `Es schauen zu: ${names.join(', ')}` : '';
    });
    sig.on('host-left', () => { playEndChime(); end('Der Stream wurde beendet.'); });
    sig.on('kicked', () => end('Du wurdest vom Host entfernt.'));
    sig.on('disconnected', () => { if (current && current.sig === sig) overlay('Verbindung zum Server verloren.'); });
  } catch (e) {
    sig.close();
    if (e.code === 'bad_password') {
      $('#pwRow').hidden = false;
      $('#inpPassword').focus();
    }
    $('#error').textContent = e.message;
  } finally {
    $('#btnWatch').disabled = false;
  }
}

let overlayClickUnmutes = false;
function overlay(text, clickUnmutes = false) {
  const el = $('#overlay');
  el.hidden = !text;
  if (text) el.textContent = text;
  overlayClickUnmutes = clickUnmutes;
}

function end(message) {
  leave();
  $('#error').textContent = message;
}

function leave() {
  if (!current) return;
  current.session.stop();
  current.sig.close();
  current = null;
  if (document.fullscreenElement) document.exitFullscreen();
  $('#video').srcObject = null;
  $('#player').hidden = true;
  $('#lobby').hidden = false;
  $('#stats').textContent = '';
  $('#audience').textContent = '';
  document.title = 'KM-DEV Stream';
}

$('#inpCode').value = codeFromHash();
$('#inpName').value = storage('kmdev-name');
updateAppLink();
if ($('#inpCode').value) $('#lobbyTitle').textContent = `Stream ${$('#inpCode').value}`;

$('#inpCode').addEventListener('input', updateAppLink);
$('#btnWatch').addEventListener('click', watch);
for (const id of ['#inpCode', '#inpName', '#inpPassword']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') watch(); });
}
$('#btnLeave').addEventListener('click', leave);
$('#volume').addEventListener('input', (e) => {
  const video = $('#video');
  video.volume = Number(e.target.value);
  video.muted = false;
});
$('#overlay').addEventListener('click', () => {
  if (!overlayClickUnmutes) return;
  $('#video').muted = false;
  overlay(null);
});
$('#btnFullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#player').requestFullscreen();
});
$('#video').addEventListener('dblclick', () => $('#btnFullscreen').click());
window.addEventListener('hashchange', () => {
  if (current) return;
  $('#inpCode').value = codeFromHash();
  updateAppLink();
});
