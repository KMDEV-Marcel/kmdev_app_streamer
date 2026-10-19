// Ein Stream im eigenen Fenster (z. B. auf dem zweiten Monitor). Eigene
// Zuschauer-Verbindung, unabhaengig vom Hauptfenster.
import { Tile } from './tiles.js';
import { hydrateIcons } from './icons.js';
import { playEndChime } from './sounds.js';
import { showMenu } from './menu.js';

const $ = (sel) => document.querySelector(sel);
hydrateIcons();
const data = JSON.parse(atob(new URLSearchParams(location.search).get('d').replace(/-/g, '+').replace(/_/g, '/')));

// Die Tile-Klasse rendert ihr eigenes Element; hier wird nur ihre Verbindung
// genutzt und an die feste Oberflaeche dieses Fensters gehaengt.
const tile = new Tile({ serverUrl: data.serverUrl, room: data.room, password: data.password, name: data.name });
tile.video = $('#video');
tile.el = document.querySelector('.popout-tile');
tile.initZoom();
tile.setVolume(data.volume ?? 1);
tile.setMuted(!!data.muted);
window.addEventListener('resize', () => tile.applyZoom());

tile.addEventListener('ended', (e) => {
  if (data.endSound !== false) playEndChime();
  tile.overlay(e.detail.message);
  if (tile.session) tile.session.stop();
});

$('#volume').addEventListener('input', (e) => tile.setVolume(Number(e.target.value)));
$('#btnMute').addEventListener('click', () => tile.setMuted(!tile.muted));
$('#btnFull').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});
$('#video').addEventListener('dblclick', () => $('#btnFull').click());
let pinned = false;
async function togglePin() {
  pinned = await window.api.pinPopout(!pinned);
  $('#btnPin').classList.toggle('active', pinned);
}
$('#btnPin').addEventListener('click', togglePin);

// Zurueck als Kachel ins Hauptfenster; dieses Fenster schliesst der Hauptprozess.
function dock() {
  window.api.dockPopout({
    serverUrl: tile.serverUrl,
    room: tile.room,
    password: tile.password,
    volume: tile.volume,
    muted: tile.muted
  });
}
$('#btnDock').addEventListener('click', dock);

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    ...tile.baseMenu(),
    '-',
    { label: pinned ? 'Nicht mehr im Vordergrund' : 'Immer im Vordergrund', icon: 'push_pin', action: togglePin },
    { label: 'Wieder andocken', icon: 'dock', action: dock },
    '-',
    { label: 'Stream beenden', icon: 'close', danger: true, action: () => window.close() }
  ]);
});

tile.connect()
  .then(() => { document.title = `${tile.title} – ${tile.hostName}`; })
  .catch((e) => tile.overlay(e.message));
window.addEventListener('beforeunload', () => tile.close());
