// @vitest-environment jsdom
// #17: the page declares an inline icon, so the browser never requests a missing /favicon.ico.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from the repository root (vitest.config.ts root: '.').
const html = readFileSync(join(process.cwd(), 'src', 'web', 'index.html'), 'utf8');

describe('index.html', () => {
  it('has an inline SVG favicon (data: URI, no network request)', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const icons = [...doc.querySelectorAll('link[rel~="icon"]')];
    expect(icons).toHaveLength(1);
    const href = icons[0]!.getAttribute('href') ?? '';
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = new DOMParser().parseFromString(decodeURIComponent(href.slice('data:image/svg+xml,'.length)), 'image/svg+xml');
    expect(svg.querySelector('parsererror')).toBeNull();
    expect(svg.documentElement.nodeName).toBe('svg');
    expect(svg.documentElement.getAttribute('viewBox')).toBe('0 0 32 32');
  });
});
