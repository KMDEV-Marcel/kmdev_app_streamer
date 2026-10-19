/*
 * Dauerhafte Verbindung zur Stream-Liste.
 *
 * Die App abonniert die Liste ('subscribe') und bekommt jede Aenderung sofort
 * vom Server. So kann sie melden, wenn jemand live geht – auch minimiert.
 * Aeltere Server kennen 'subscribe' nicht; dann wird regelmaessig per 'list'
 * nachgefragt – alle 5 s, solange die Liste zu sehen ist, sonst alle 15 s.
 *
 * Ereignisse: 'rooms' (detail: Liste), 'error' (detail: Error), 'state'
 */
import { Signaling } from './rtc.js';

export const POLL_SLOW = 15000;
export const POLL_FAST = 5000;

export class Lobby extends EventTarget {
  constructor() {
    super();
    this.url = '';
    this.key = '';
    this.sig = null;
    this.rooms = [];
    this.connected = false;
    this.retry = 0;
    this.retryTimer = null;
    this.pollTimer = null;
    this.pollMs = POLL_SLOW;
  }

  // Abfrage-Takt aendern; beim Beschleunigen sofort einmal nachfragen.
  setPollInterval(ms) {
    if (ms === this.pollMs) return;
    const faster = ms < this.pollMs;
    this.pollMs = ms;
    if (!this.connected) return;
    this.startPolling();
    if (faster) this.sig.send({ type: 'list', key: this.key });
  }

  startPolling() {
    clearInterval(this.pollTimer);
    const sig = this.sig;
    this.pollTimer = setInterval(() => sig.send({ type: 'list', key: this.key }), this.pollMs);
  }

  // Neu verbinden, wenn sich Server oder Schluessel geaendert haben.
  // Liefert true, wenn dabei neu verbunden wurde.
  configure(url, key) {
    url = url || '';
    key = key || '';
    if (url === this.url && key === this.key && (this.sig || this.retryTimer || !url)) return false;
    this.url = url;
    this.key = key;
    this.reconnect();
    return true;
  }

  reconnect() {
    this.retry = 0;
    this.close();
    if (this.url) this.connect();
  }

  // Liste sofort neu holen (Knopf „Aktualisieren“).
  refresh() {
    if (this.connected) this.sig.send({ type: 'list', key: this.key });
    else this.reconnect();
  }

  async connect() {
    const sig = new Signaling(this.url);
    this.sig = sig;
    sig.on('rooms', (m) => {
      if (this.sig !== sig) return;
      this.rooms = m.rooms || [];
      this.emit('rooms', this.rooms);
    });
    sig.on('error', (m) => {
      if (this.sig !== sig) return;
      this.emit('error', Object.assign(new Error(m.message), { code: m.code }));
    });
    sig.on('disconnected', () => {
      // Fehlgeschlagener Aufbau wird unten in catch behandelt.
      if (this.sig !== sig || !this.connected) return;
      this.connected = false;
      this.emit('state', false);
      this.schedule();
    });
    try {
      await sig.connect();
    } catch (e) {
      if (this.sig !== sig) return;
      this.emit('error', e);
      this.schedule();
      return;
    }
    if (this.sig !== sig) return;
    this.connected = true;
    this.retry = 0;
    this.emit('state', true);
    sig.send({ type: 'subscribe', key: this.key });
    // Rueckfall fuer Server ohne Abo: regelmaessig nachfragen. Mit Abo kostet
    // das nur eine kleine Nachricht und faengt verpasste Aenderungen ab.
    this.startPolling();
  }

  // Wiederverbinden mit wachsender Pause (2 s … 60 s).
  schedule() {
    clearInterval(this.pollTimer);
    clearTimeout(this.retryTimer);
    if (!this.url) return;
    const ms = Math.min(60000, 2000 * 2 ** this.retry++);
    this.retryTimer = setTimeout(() => this.connect(), ms);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  close() {
    clearInterval(this.pollTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const sig = this.sig;
    this.sig = null;
    this.connected = false;
    if (sig) sig.close();
  }
}
