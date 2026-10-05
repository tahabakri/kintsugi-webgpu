const PATHS = {
  strike: '<path d="M4 20 13.5 10.5"/><path d="m12 6 3.2-3.2 6 6L18 12Z"/><path d="m13.6 7.6 2.8 2.8"/>',
  drop: '<path d="M12 3.5v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20.5h14"/>',
  brush: '<path d="m9.5 14.5 9.6-11.2a1.6 1.6 0 0 1 2.4 2.1L11.8 16.6"/><path d="M9.6 14.4c-2.4-.5-4 .9-4.3 2.9-.3 2.1-1.5 2.7-2.8 2.9 2.9 1.5 7.8 1 9.3-3.5"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4 3.5V8h4.5"/>',
  pause: '<path d="M9 5v14"/><path d="M15 5v14"/>',
  play: '<path d="M8 5.5v13L18.5 12Z"/>',
  view: '<path d="M8 4H4v4"/><path d="M16 4h4v4"/><path d="M4 16v4h4"/><path d="M20 16v4h-4"/><circle cx="12" cy="12" r="2.6"/>',
  recover: '<path d="M4 15.5 8.5 20 13 15.5"/><path d="M8.5 20V9.5A5.5 5.5 0 0 1 14 4h6"/>',
  chevron: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** Inline line icon; nothing is fetched. */
export function icon(name: IconName): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}
