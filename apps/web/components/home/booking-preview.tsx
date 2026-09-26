import type { Locale, Money } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';

import { Icon } from '@/components/ui/icon';
import { formatMoney, formatTimeInTimeZone, type DisplayLocale } from '@/lib/format';

/**
 * L'illustration du héros de l'accueil : un rendez-vous en train de se prendre
 * (#927).
 *
 * ## Du balisage plutôt qu'une image
 *
 * Une capture d'écran vieillirait au premier changement d'interface, pèserait
 * sur le LCP de la page et ne suivrait ni le thème sombre ni la rampe de marque.
 * Ces trois cartes sont peintes avec les jetons du design system : elles
 * changent avec le produit, et coûtent quelques centaines d'octets.
 *
 * ## Décorative, et déclarée comme telle
 *
 * Elle montre ce que le texte voisin dit déjà — choisir une prestation, un
 * créneau, recevoir la confirmation. Elle est donc masquée aux technologies
 * d'assistance : une lectrice d'écran entendrait sinon un faux rendez-vous, avec
 * un prix et une heure, au milieu de la présentation du produit.
 *
 * ## La langue (#846)
 *
 * Masquée aux lecteurs d'écran ne veut pas dire invisible : tout ce qui est
 * peint ici se lit à l'œil, et se traduit donc comme le reste de l'accueil.
 *
 * Deux valeurs ne viennent pas du catalogue mais de `lib/format.ts`, parce que
 * ce sont un montant et des heures, et que la règle de `CLAUDE.md` ne souffre
 * pas d'exception décorative — une heure écrite à la main annoncerait « 14:00 »
 * à qui lit « 2:00 PM » :
 *
 * - le **prix**, un entier et une devise, mis en forme par `formatMoney`. La
 *   devise suit la langue lue — voir {@link PREVIEW_PRICE} ;
 * - les **créneaux**, six instants d'un jeudi fictif lus dans le référentiel
 *   UTC. Le fuseau n'est pas celui d'un établissement — il n'y en a aucun ici —
 *   mais celui dans lequel ces instants ont été écrits, pour que l'illustration
 *   montre les mêmes heures d'un continent à l'autre.
 *
 * La durée, elle, reste dans le catalogue : `formatDuration(60)` rendrait
 * « 1 h », quand la vignette veut montrer la durée telle qu'un catalogue de
 * prestations l'affiche.
 *
 * Server Component synchrone : `useLocale` et `useTranslations` y fonctionnent,
 * et rien ici n'a d'état à hydrater.
 */

/**
 * Le prix de la prestation illustrée — entier et devise, jamais un flottant.
 *
 * **Une devise par langue**, et non une seule pour les deux (#1300). L'accueil
 * anglais affichait « €75.00 » : la mise en forme suivait bien la langue, mais
 * la devise, elle, était figée en euros, alors que la clientèle du produit est
 * nord-américaine — c'est la décision du PO du 2026-09-19 dont
 * `lib/salon-presets.ts` tire son pays par défaut, les États-Unis. Un prix
 * d'illustration en monnaie étrangère fait douter du produit avant même qu'on
 * l'essaie.
 *
 * Les devises sont écrites ici plutôt que déduites du pays de repli de
 * `lib/format.ts` : la racine du domaine ne sert aucun établissement, il n'y a
 * donc pas de pays à lire, et l'accord tient à ce que les deux tables nomment
 * les mêmes régions — `en` → `en-US` → dollar, `fr` → `fr-FR` → euro.
 *
 * `Record<Locale, …>` et non un objet libre : une troisième langue ne peut pas
 * s'ajouter au produit sans que `tsc` réclame son prix.
 */
const PREVIEW_PRICE: Readonly<Record<Locale, Money>> = {
  en: { amountMinor: 7500, currency: 'USD' },
  fr: { amountMinor: 7500, currency: 'EUR' },
};

/**
 * Le jeudi fictif des créneaux.
 *
 * Les instants sont écrits en UTC et relus en UTC : la vignette n'illustre
 * aucun salon, et un décalage y ferait seulement mentir la légende du jour.
 * Le 1er janvier 2026 est un jeudi — c'est ce que dit `home.preview.day`.
 */
const SLOTS = [
  { at: '2026-01-01T09:30:00Z', state: 'free' },
  { at: '2026-01-01T10:00:00Z', state: 'taken' },
  { at: '2026-01-01T10:30:00Z', state: 'selected' },
  { at: '2026-01-01T11:00:00Z', state: 'free' },
  { at: '2026-01-01T14:00:00Z', state: 'free' },
  { at: '2026-01-01T15:30:00Z', state: 'free' },
] as const;

export function BookingPreview() {
  const t = useTranslations('booking');
  const locale = useLocale() as Locale;
  // Aucun établissement sur la racine du domaine : la région de repli de
  // `lib/format.ts` (`en` → `en-US`, `fr` → `fr-FR`) s'applique.
  const display: DisplayLocale = { locale, countryCode: null };

  return (
    <div className="spa-home-preview" aria-hidden="true">
      <div className="spa-home-preview__card spa-home-preview__card--service">
        <span className="spa-home-preview__badge">
          <Icon name="sparkle" className="spa-home-preview__badge-icon" />
          {t('home.preview.category')}
        </span>
        <p className="spa-home-preview__title">{t('home.preview.service')}</p>
        <p className="spa-home-preview__meta">{t('home.preview.meta')}</p>
        <p className="spa-home-preview__price">{formatMoney(PREVIEW_PRICE[locale], display)}</p>
      </div>

      <div className="spa-home-preview__card spa-home-preview__card--slots">
        <p className="spa-home-preview__day">
          <Icon name="calendar" className="spa-home-preview__day-icon" />
          {t('home.preview.day')}
        </p>
        <ul className="spa-home-preview__slots">
          {SLOTS.map((slot) => (
            <li
              key={slot.at}
              className={`spa-home-preview__slot spa-home-preview__slot--${slot.state}`}
            >
              {formatTimeInTimeZone(slot.at, 'UTC', display)}
            </li>
          ))}
        </ul>
      </div>

      <div className="spa-home-preview__toast">
        <span className="spa-home-preview__toast-icon">
          <Icon name="check" />
        </span>
        <p className="spa-home-preview__toast-text">
          <strong>{t('home.preview.toastTitle')}</strong>
          <span>{t('home.preview.toastText')}</span>
        </p>
      </div>
    </div>
  );
}
