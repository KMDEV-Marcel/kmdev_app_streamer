/*
 * Mehrere Streams gleichzeitig ansehen.
 *
 * Jede Kachel ist eine eigene Zuschauer-Verbindung (Signaling + WebRTC).
 * Anordnungen:
 *   grid  - Raster, Kacheln teilen sich den Platz automatisch
 *   focus - eine Kachel gross, die anderen in einer Leiste daneben
 *   free  - Kacheln frei verschieben (ziehen) und skalieren (Ecke)
 */
import { Signaling, ViewerSession } from './rtc.js';
import { icon } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let nextId = 1;

export class Tile extends EventTarget {
  constructor({ serverUrl, room, password, name }) {
    super();
    this.id = nextId++;
    this.serverUrl = serverUrl;
    this.room = room;
    this.password = password || '';
    this.name = name;
    this.title = room;
    this.hostName = '';
    this.mode = 'p2p';
    this.volume = 1;
    this.muted = false;
    this.sig = null;
    this.session = null;
    this.rect = null; // freie Anordnung: { x, y, w, h } in Prozent
    this.el = this.render();
  }

  render() {
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.id = this.id;
    el.innerHTML = `
      <video autoplay playsinline></video>
      <div class="tile-overlay">Verbinde…</div>
      <span class="tile-stats"></span>
      <div class="tile-name"><span class="dot"></span><span class="tile-host"></span><span class="tile-title">${esc(this.room)}</span></div>
      <span class="tile-muted">${icon('volume_off')}stumm</span>
      <div class="tile-ctrl">
        <span class="vol">
          <button class="tile-mute" title="Stumm">${icon('volume_up')}</button>
          <input class="tile-vol" type="range" min="0" max="1" step="0.01" value="1" title="Lautstärke">
        </span>
        <button class="tile-focus" title="Groß anzeigen">${icon('open_in_full')}</button>
        <button class="tile-popout" title="In eigenem Fenster öffnen">${icon('open_in_new')}</button>
        <button class="tile-full" title="Vollbild">${icon('fullscreen')}</button>
        <button class="tile-close" title="Schließen">${icon('close')}</button>
      </div>
      <div class="tile-resize" title="Größe ändern"></div>`;
    this.video = el.querySelector('video');
    el.querySelector('.tile-vol').addEventListener('input', (e) => this.setVolume(Number(e.target.value)));
    el.querySelector('.tile-mute').addEventListener('click', () => this.setMuted(!this.muted));
    el.querySelector('.tile-full').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen();
    });
    el.querySelector('.tile-close').addEventListener('click', () => this.emit('close'));
    el.querySelector('.tile-popout').addEventListener('click', () => this.emit('popout'));
    el.querySelector('.tile-focus').addEventListener('click', () => this.emit('focus'));
    this.video.addEventListener('dblclick', () => this.emit('focus'));
    return el;
  }

  emit(type) {
    this.dispatchEvent(new CustomEvent(type, { detail: this }));
  }

  overlay(text) {
    const o = this.el.querySelector('.tile-overlay');
    o.hidden = !text;
    if (text) o.textContent = text;
  }

  setVolume(v) {
    this.volume = v;
    this.video.volume = v;
    if (v > 0 && this.muted) this.setMuted(false);
    this.el.querySelector('.tile-vol').value = v;
  }

  setMuted(m) {
    this.muted = m;
    this.video.muted = m;
    this.el.querySelector('.tile-mute').innerHTML = icon(m ? 'volume_off' : 'volume_up');
    this.el.classList.toggle('muted', m);
  }

  async connect() {
    const sig = new Signaling(this.serverUrl);
    this.sig = sig;
    await sig.connect();
    const res = await sig.request({ type: 'join', room: this.room, password: this.password, name: this.name }, 'joined');
    this.title = res.title || 'Stream';
    this.hostName = res.hostName;
    this.mode = res.mode;
    const host = this.el.querySelector('.tile-host');
    if (host) {
      host.textContent = this.hostName;
      this.el.querySelector('.tile-title').textContent = this.title;
    } else {
      this.el.querySelector('.tile-title').textContent = `${this.title} – ${this.hostName}`;
    }

    const session = new ViewerSession({ signaling: sig, iceServers: res.iceServers, hostId: res.hostId });
    this.session = session;
    session.addEventListener('track', (e) => {
      this.video.srcObject = e.detail;
      this.video.play().catch(() => {});
    });
    session.addEventListener('state', (e) => {
      const st = e.detail;
      if (st === 'connected') this.overlay(null);
      else if (st === 'failed') this.overlay('Verbindung fehlgeschlagen (Firewall/NAT).');
      else if (st === 'disconnected') this.overlay('Verbindung unterbrochen…');
    });
    session.addEventListener('stats', (e) => {
      const s = e.detail;
      this.el.querySelector('.tile-stats').textContent = [
        s.width ? `${s.width}×${s.height}` : null,
        s.fps != null ? `${s.fps} fps` : null,
        s.kbps != null ? `${(s.kbps / 1000).toFixed(1)} Mbit/s` : null,
        s.codec || null,
        s.relay ? 'TURN' : null,
        this.mode === 'server' ? 'Server' : null
      ].filter(Boolean).join(' · ');
    });
    sig.on('host-left', () => this.end('Der Stream wurde beendet.'));
    sig.on('kicked', () => this.end('Du wurdest vom Host entfernt.'));
    sig.on('disconnected', () => { if (this.session) this.overlay('Verbindung zum Server verloren.'); });
  }

  end(message) {
    this.dispatchEvent(new CustomEvent('ended', { detail: { tile: this, message } }));
  }

  close() {
    if (this.session) this.session.stop();
    if (this.sig) this.sig.close();
    this.session = null;
    this.sig = null;
    if (document.fullscreenElement === this.el) document.exitFullscreen();
    this.video.srcObject = null;
    this.el.remove();
  }
}

export class TileManager extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.tiles = [];
    this.layout = 'grid';
    this.focusId = null;
    this.z = 1;
    new ResizeObserver(() => this.arrange()).observe(container);
    this.wireFreeLayout();
  }

  get size() {
    return this.tiles.length;
  }

  has(room) {
    return this.tiles.some((t) => t.room === room);
  }

  async open({ serverUrl, room, password, name }) {
    const existing = this.tiles.find((t) => t.room === room);
    if (existing) {
      this.focus(existing.id);
      return existing;
    }
    const tile = new Tile({ serverUrl, room, password, name });
    tile.addEventListener('close', () => this.remove(tile));
    tile.addEventListener('focus', () => this.toggleFocus(tile.id));
    tile.addEventListener('popout', () => this.dispatchEvent(new CustomEvent('popout', { detail: tile })));
    tile.addEventListener('ended', (e) => {
      this.remove(tile);
      this.dispatchEvent(new CustomEvent('ended', { detail: e.detail }));
    });
    this.tiles.push(tile);
    this.container.appendChild(tile.el);
    this.arrange();
    try {
      await tile.connect();
    } catch (e) {
      this.remove(tile);
      throw e;
    }
    this.changed();
    return tile;
  }

  remove(tile) {
    const i = this.tiles.indexOf(tile);
    if (i < 0) return;
    this.tiles.splice(i, 1);
    tile.close();
    if (this.focusId === tile.id) this.focusId = null;
    this.arrange();
    this.changed();
  }

  closeAll() {
    for (const t of [...this.tiles]) this.remove(t);
  }

  changed() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  setLayout(layout) {
    this.layout = layout;
    this.arrange();
  }

  focus(id) {
    this.focusId = id;
    if (this.layout === 'grid') this.layout = 'focus';
    this.arrange();
    this.dispatchEvent(new CustomEvent('layout', { detail: this.layout }));
  }

  toggleFocus(id) {
    if (this.layout === 'focus' && this.focusId === id) {
      this.layout = 'grid';
      this.arrange();
      this.dispatchEvent(new CustomEvent('layout', { detail: this.layout }));
    } else {
      this.focus(id);
    }
  }

  arrange() {
    const c = this.container;
    c.classList.remove('layout-grid', 'layout-focus', 'layout-free');
    c.classList.add(`layout-${this.layout}`);
    const n = this.tiles.length;
    for (const t of this.tiles) {
      t.el.style.cssText = '';
      t.el.classList.remove('focused');
    }
    if (!n) return;

    if (this.layout === 'grid') {
      // Spalten so waehlen, dass 16:9-Kacheln moeglichst gross werden.
      const W = c.clientWidth, H = c.clientHeight;
      let best = { cols: 1, size: 0 };
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const w = Math.min(W / cols, (H / rows) * 16 / 9);
        if (w > best.size) best = { cols, size: w };
      }
      c.style.gridTemplateColumns = `repeat(${best.cols}, 1fr)`;
      c.style.gridTemplateRows = `repeat(${Math.ceil(n / best.cols)}, 1fr)`;
    } else if (this.layout === 'focus') {
      if (!this.tiles.some((t) => t.id === this.focusId)) this.focusId = this.tiles[0].id;
      c.style.gridTemplateColumns = n > 1 ? 'minmax(0, 1fr) clamp(180px, 20%, 320px)' : '1fr';
      c.style.gridTemplateRows = `repeat(${Math.max(n - 1, 1)}, minmax(0, 1fr))`;
      let row = 1;
      for (const t of this.tiles) {
        if (t.id === this.focusId) {
          t.el.classList.add('focused');
          t.el.style.gridColumn = '1';
          t.el.style.gridRow = `1 / span ${Math.max(n - 1, 1)}`;
        } else {
          t.el.style.gridColumn = '2';
          t.el.style.gridRow = String(row++);
        }
      }
    } else {
      c.style.gridTemplateColumns = '';
      c.style.gridTemplateRows = '';
      this.tiles.forEach((t, i) => {
        if (!t.rect) t.rect = { x: 4 + (i % 4) * 6, y: 4 + (i % 4) * 8, w: 44, h: 44 };
        this.applyRect(t);
      });
    }
  }

  applyRect(t) {
    const r = t.rect;
    Object.assign(t.el.style, { left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` });
  }

  // Ziehen an der Titelleiste verschiebt, Ziehen an der Ecke skaliert.
  wireFreeLayout() {
    this.container.addEventListener('pointerdown', (e) => {
      if (this.layout !== 'free') return;
      const el = e.target.closest('.tile');
      if (!el) return;
      const tile = this.tiles.find((t) => String(t.id) === el.dataset.id);
      el.style.zIndex = String(++this.z);
      const resize = e.target.classList.contains('tile-resize');
      // Verschieben: ueberall auf der Kachel ausser auf den Bedienelementen.
      const move = !resize && !e.target.closest('.tile-ctrl');
      if (!tile || (!resize && !move)) return;
      e.preventDefault();
      const box = this.container.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, rect: { ...tile.rect } };
      el.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        const dx = ((ev.clientX - start.x) / box.width) * 100;
        const dy = ((ev.clientY - start.y) / box.height) * 100;
        const r = { ...start.rect };
        if (resize) {
          r.w = Math.min(100 - r.x, Math.max(12, r.w + dx));
          r.h = Math.min(100 - r.y, Math.max(12, r.h + dy));
        } else {
          r.x = Math.min(100 - r.w, Math.max(0, r.x + dx));
          r.y = Math.min(100 - r.h, Math.max(0, r.y + dy));
        }
        tile.rect = r;
        this.applyRect(tile);
      };
      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }
}
