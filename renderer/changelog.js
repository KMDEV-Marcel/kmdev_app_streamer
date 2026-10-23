/*
 * Neuerungen pro Version – wird nach einem Update einmal angezeigt.
 * Neueste Version oben. Bei jedem Release einen Eintrag ergaenzen.
 */
export const CHANGELOG = [
  {
    version: '0.4.5',
    items: [
      'Der eigene Stream pausiert, solange du ein Fenster außerhalb der App benutzt – abschaltbar in den Einstellungen.',
      'Neues Logo.'
    ]
  },
  {
    version: '0.4.4',
    items: [
      'Kein Fehlerfenster mehr beim Beenden der App.',
      'Unerwartete Fehler werden in error.log im Einstellungsordner festgehalten.'
    ]
  },
  {
    version: '0.4.3',
    items: [
      'Nach einem Update siehst du, was neu ist.',
      'Fenster schließen beendet den eigenen Stream direkt, ohne Rückfrage.',
      'Die Live-Liste aktualisiert sich alle 5 Sekunden, solange du sie offen hast.'
    ]
  },
  {
    version: '0.4.2',
    items: [
      'Zoom im Stream: Mausrad zoomt, Ziehen verschiebt den Ausschnitt.',
      'Rechtsklick auf einen Stream: Ton, Zoom, eigenes Fenster, Stream beenden.',
      'Streams im eigenen Fenster lassen sich wieder andocken.',
      'Live-Benachrichtigungen sind als „wichtig“ markiert.'
    ]
  },
  {
    version: '0.4.1',
    items: ['Live-Benachrichtigungen kommen immer als Windows-Benachrichtigung.']
  },
  {
    version: '0.4.0',
    items: [
      'Live-Liste mit Vorschaubild, Laufzeit und Zuschauern.',
      'Als Zuschauer siehst du, wer noch zuschaut.',
      'Benachrichtigung mit „Beitreten“, wenn jemand live geht.',
      'Ton, wenn ein Stream endet, den du ansiehst.',
      'Autostart mit Windows.'
    ]
  }
];

function cmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// Eintraege neuer als `from` bis einschliesslich `to`.
export function changesBetween(from, to) {
  return CHANGELOG.filter((e) => cmp(e.version, from) > 0 && cmp(e.version, to) <= 0);
}
