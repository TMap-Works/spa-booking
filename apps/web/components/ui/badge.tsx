import type { ReactNode } from 'react';

import type { AppointmentTone } from '@/lib/appointment-status';

/**
 * Tonalités d'état génériques, puis statuts de rendez-vous. Les seconds ont
 * leurs propres jetons (`--spa-color-status-*`) : « annulé » n'est pas
 * « erreur », et un salon doit pouvoir repeindre l'un sans l'autre.
 */
export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | AppointmentTone;

interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
}

/**
 * Pastille de statut (#1044).
 *
 * Le libellé est toujours écrit (BM-VISUEL-05, WCAG 1.4.1) : le point coloré
 * et la teinte ne font que l'appuyer, ils ne le remplacent jamais.
 */
export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return <span className={`spa-badge spa-badge--${tone}`}>{children}</span>;
}
