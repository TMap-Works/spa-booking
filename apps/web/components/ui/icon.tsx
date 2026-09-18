/**
 * Pictogrammes au trait, dessinés en ligne (#927).
 *
 * En ligne plutôt qu'en fichiers ou en police d'icônes : aucun aller-retour
 * réseau avant le premier rendu, et la couleur suit le texte par `currentColor`
 * — donc les jetons, le thème sombre et la rampe d'un salon sans une ligne de
 * plus.
 *
 * Toujours **décoratifs** : un pictogramme accompagne un libellé écrit et ne le
 * remplace jamais (WCAG 1.1.1). Il est donc masqué aux technologies
 * d'assistance, et aucun composant ne peut lui donner de nom.
 */

const PATHS = {
  calendar: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm3 8h2m3 0h2m-7 4h2',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  bell: 'M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15L6 17Zm4 3.5a2 2 0 0 0 4 0',
  card: 'M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Zm0 3h18M7 15h3',
  chart: 'M4 20h16M7 16v-4m5 4V8m5 8v-6',
  clock: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-4',
  users: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1m18 0v-1a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75M13.5 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  sparkle: 'M12 3.5 13.9 9 19.5 11l-5.6 2L12 18.5 10.1 13 4.5 11l5.6-2L12 3.5ZM18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z',
  leaf: 'M5 19c0-8.3 5.2-14 15-14 0 9.8-5.7 15-14 15H5Zm0 0 8.5-8.5',
  store: 'M4 9.5 5.5 4h13L20 9.5M4 9.5h16M4 9.5a2.67 2.67 0 0 0 5.33 0 2.67 2.67 0 0 0 5.34 0 2.67 2.67 0 0 0 5.33 0M5 12v8h14v-8M10 20v-4h4v4',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8.5Z',
  sun: 'M12 3v1.5m0 15V21m9-9h-1.5M4.5 12H3m15.36-6.36-1.06 1.06M6.7 17.3l-1.06 1.06m0-12.72L6.7 6.7m10.6 10.6 1.06 1.06M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  monitor: 'M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm4 15h8m-4-4v4',
  tag: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8a1 1 0 0 1 0 1.4l-7.6 7.6a1 1 0 0 1-1.4 0l-8-8Zm4.5-5h.01',
  team: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M13.5 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm2.5 4 2 2 4-4',
  sliders: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5m5 5H3',
  external: 'M14 4h6v6m0-6-9 9m7 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
  readonly name: IconName;
  /** Classe de mise en page — la taille se règle en CSS, jamais ici. */
  readonly className?: string;
}

export function Icon({ name, className }: IconProps) {
  return (
    <svg
      className={className === undefined ? 'spa-icon' : `spa-icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
