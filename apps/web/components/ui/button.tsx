import { useTranslations } from 'next-intl';
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
  /**
   * Ce que les lecteurs d'écran annoncent pendant l'attente.
   *
   * Omis, c'est la phrase générique du catalogue (`ui.button.loading`) dans la
   * langue de la page. Un écran qui sait dire *ce* qui est en cours — « Création
   * du rendez-vous… » — le passe ; les autres n'ont plus de littéral français à
   * écrire pour cela (#845).
   */
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
  loadingLabel,
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
          <span className="spa-visually-hidden">
            {loadingLabel === undefined ? <ButtonLoadingLabel /> : loadingLabel}
          </span>
        </>
      ) : null}
    </button>
  );
}

/**
 * La phrase générique d'attente, lue dans le catalogue — et **seulement quand
 * elle est affichée** (#845).
 *
 * Un composant à part, et non un `useTranslations` dans `Button` : ce bouton est
 * la brique la plus rendue du produit — un écran du back-office en affiche des
 * dizaines —, et aucun n'est en attente la plupart du temps. Appeler le crochet
 * dans `Button` aurait abonné chacun d'eux au contexte des messages pour une
 * chaîne que presque aucun n'affiche jamais. Ici, le coût est payé par le seul
 * bouton qui tourne, à l'instant où il tourne.
 */
function ButtonLoadingLabel() {
  const t = useTranslations('ui.button');

  return <>{t('loading')}</>;
}
