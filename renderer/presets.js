// Aufloesungsstufen: Hoehe in Pixeln, Breite ergibt sich aus 16:9.
// 'source' = native Aufloesung der Quelle, keine Skalierung.
export const RESOLUTIONS = {
  '360': { width: 640, height: 360 },
  '480': { width: 854, height: 480 },
  '720': { width: 1280, height: 720 },
  '1080': { width: 1920, height: 1080 },
  '1440': { width: 2560, height: 1440 },
  source: null
};

export const FPS_OPTIONS = [5, 30, 60];
export const AUDIO_BITRATES = [64, 96, 128, 192, 256, 320];

// Voreinstellungen setzen Aufloesung, FPS und Bitrate in einem Rutsch.
// 'presentation' optimiert fuer gestochen scharfen Text bei wenig Bewegung.
export const PRESETS = {
  '360': { resolution: '360', fps: 30, bitrate: 1000 },
  '480': { resolution: '480', fps: 30, bitrate: 1500 },
  '720': { resolution: '720', fps: 60, bitrate: 3500 },
  '1080': { resolution: '1080', fps: 60, bitrate: 6000 },
  '1440': { resolution: '1440', fps: 60, bitrate: 10000 },
  source: { resolution: 'source', fps: 60, bitrate: 8000 },
  presentation: { resolution: 'source', fps: 5, bitrate: 2500 }
};

export const PRESET_LABELS = {
  '360': '360', '480': '480', '720': '720', '1080': '1080', '1440': '1440',
  source: 'Quelle', presentation: 'Präsentation'
};

export const BITRATE_MIN = 250;
export const BITRATE_MAX = 50000;
export const BITRATE_STEP = 500;

// Liefert den Preset-Schluessel, der zu den aktuellen Werten passt – oder
// null, wenn manuell abgewichen wurde (dann ist kein Preset markiert).
export function matchPreset(s) {
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.resolution === s.resolution && p.fps === s.fps && p.bitrate === s.bitrate) return key;
  }
  return null;
}

export function videoConstraints(s) {
  const res = RESOLUTIONS[s.resolution];
  const c = { frameRate: { ideal: s.fps, max: s.fps } };
  if (res) {
    c.width = { max: res.width };
    c.height = { max: res.height };
  }
  return c;
}
