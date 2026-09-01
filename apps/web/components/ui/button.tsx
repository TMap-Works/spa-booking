import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'accent' | 'neutral' | 'quiet' | 'danger';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  readonly variant?: ButtonVariant;
  readonly block?: boolean;
  /**
   * Action en vol. Le bouton se désactive et affiche son spinner **sans perdre
   * sa largeur** : le libellé reste dans le flux, seulement rendu invisible.
   * Sans cela la mise en page saute au moment précis où le visiteur vient de
   * cliquer.
   */
  readonly loading?: boolean;
  /** Ce que les lecteurs d'écran annoncent pendant l'attente. */
  readonly loadingLabel?: string;
  readonly children: ReactNode;
}

/**
 * Bouton du design system (styles/README.md §2).
 *
 * `disabled` est posé dès que `loading` l'est : c'est la règle §3 de la skill
 * `web-frontend` — *un double clic ne doit jamais produire deux réservations* —
 * et elle est tenue ici plutôt que dans chaque appelant, pour qu'aucun écran ne
 * puisse l'oublier.
 */
export function Button({
  variant = 'neutral',
  block = false,
  loading = false,
  loadingLabel = 'Traitement en cours…',
  type = 'button',
  disabled = false,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    'spa-button',
    `spa-button--${variant}`,
    block ? 'spa-button--block' : null,
    loading ? 'spa-button--loading' : null,
  ]
    .filter((name) => name !== null)
    .join(' ');

  return (
    <button {...rest} type={type} className={classes} disabled={disabled || loading}>
      <span className="spa-button__label">{children}</span>
      {loading ? (
        <>
          <span className="spa-spinner spa-button__spinner" aria-hidden="true" />
          <span className="spa-visually-hidden">{loadingLabel}</span>
        </>
      ) : null}
    </button>
  );
}
