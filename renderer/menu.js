/*
 * Kleines Kontextmenue (Rechtsklick), fuer Hauptfenster und Pop-out.
 *
 * showMenu(x, y, items) – items: { label, icon, action, danger } oder '-'
 * fuer eine Trennlinie. Positioniert wird per CSSOM (el.style), weil das
 * Pop-out-Fenster Inline-Styles per CSP verbietet.
 */
import { icon } from './icons.js';

let current = null;

export function closeMenu() {
  if (!current) return;
  current.remove();
  current = null;
}

export function showMenu(x, y, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'ctx-menu';
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      m.append(sep);
      continue;
    }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    if (it.danger) b.className = 'danger';
    b.innerHTML = `${it.icon ? icon(it.icon) : '<span class="ico"></span>'}<span></span>`;
    b.lastChild.textContent = it.label;
    b.addEventListener('click', () => {
      closeMenu();
      it.action();
    });
    m.append(b);
  }
  // Im Vollbild ist nur das Vollbild-Element sichtbar.
  (document.fullscreenElement || document.body).append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  current = m;
  m.querySelector('button')?.focus();
}

document.addEventListener('pointerdown', (e) => {
  if (current && !current.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
