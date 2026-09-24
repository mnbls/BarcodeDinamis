import { ICONS } from './icons.generated.js';

/** Inline SVG markup for a Phosphor (bold) icon. Icons inherit the text colour (currentColor). */
export function iconSvg(name, { size = 20, className = '' } = {}) {
  const inner = ICONS[name];
  if (!inner) throw new Error(`Ikon tidak dikenal: ${name}. Tambahkan ke scripts/build-icons.js lalu jalankan npm run icons:build.`);
  const cls = className ? `icon ${className}` : 'icon';
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`;
}

export const hasIcon = (name) => name in ICONS;
