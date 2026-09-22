import type { Locale } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';

import { setLocaleAction } from '@/i18n/actions';
import { SUPPORTED_LOCALES } from '@/i18n/resolve';

/**
 * Le sélecteur de langue — #845, septième critère d'acceptation.
 *
 * ## Chaque langue est nommée dans sa propre langue
 *
 * « Français » et « English », jamais « French » ni « Anglais ». Quelqu'un qui
 * cherche sa langue dans une interface qu'il ne lit pas ne la reconnaît que sous
 * son propre nom — c'est la règle que suivent les sélecteurs de langue des sites
 * publics, et c'est pourquoi les deux catalogues portent **les mêmes** valeurs
 * sous `locale.names` : elles ne se traduisent pas.
 *
 * ## Un formulaire, et pas d'état client
 *
 * Un bouton par langue, dans un `<form>` dont l'action est une action serveur.
 * Trois conséquences, toutes voulues :
 *
 * - il **fonctionne sans JavaScript** — la soumission est celle du navigateur ;
 * - il **ne quitte pas la page** : Next rejoue la route courante après l'action,
 *   sans navigation. Le tunnel de réservation garde son étape, un formulaire en
 *   cours de saisie n'est pas démonté ;
 * - ce n'est **pas un Client Component** : rien à hydrater, rien dans la charge
 *   utile RSC.
 *
 * La langue courante n'est pas un bouton mort : elle reste soumissible — c'est
 * ce qui permet de **réaffirmer** un choix que seul l'`Accept-Language` du
 * navigateur avait dicté, et donc de poser le cookie qui le gardera d'une visite
 * à l'autre. `aria-current` dit laquelle est affichée, et la variante `neutral`
 * la distingue à l'œil des autres, en `quiet`.
 *
 * ## Il ne porte aucune classe nouvelle
 *
 * Les boutons sont ceux du design system (`spa-button`). Le ticket qui donnera
 * sa place définitive au sélecteur dans chaque gabarit lui donnera sa feuille de
 * style ; ici, il s'agit d'abord qu'il existe et qu'il fonctionne dans les trois
 * coquilles.
 */
export function LocaleSwitcher({ className }: { readonly className?: string }) {
  const t = useTranslations('locale');
  const current = useLocale() as Locale;

  return (
    <form
      action={setLocaleAction}
      aria-label={t('label')}
      className={className === undefined ? 'spa-locale-switcher' : `spa-locale-switcher ${className}`}
    >
      {SUPPORTED_LOCALES.map((locale) => {
        const language = t(`names.${locale}` as 'names.en');
        const selected = locale === current;

        return (
          <button
            aria-current={selected ? 'true' : undefined}
            className={`spa-button ${selected ? 'spa-button--neutral' : 'spa-button--quiet'}`}
            key={locale}
            lang={locale}
            name="locale"
            title={selected ? t('current', { language }) : t('switchTo', { language })}
            type="submit"
            value={locale}
          >
            <span className="spa-button__label">{language}</span>
          </button>
        );
      })}
    </form>
  );
}
