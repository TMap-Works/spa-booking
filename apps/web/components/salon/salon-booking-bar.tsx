import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';

import { LinkPending } from '@/components/ui/link-pending';

import { publicExitLabels } from './public-exits';

interface SalonBookingBarProps {
  /** Chemin du tunnel — `null` quand rien n'est réservable, la barre disparaît. */
  readonly href: string | null;
  /** Le nombre de prestations publiées, annoncé à gauche du bouton. */
  readonly serviceCount: number;
}

/**
 * La barre de réservation collante du pouce (#1046, BM-VITRINE-04).
 *
 * ## Ce qu'elle répare
 *
 * « À 360 px, le bouton “Prendre rendez-vous” disparaît au premier
 * défilement » (audit `d20260918-1`). BM-VITRINE-04 décrit l'inverse : « à
 * 390 px, une barre collée en bas avec le nombre de prestations et “Réserver” ».
 * L'action principale reste à portée de pouce, quel que soit le défilement.
 *
 * ## Pourquoi `position: sticky` et aucun JavaScript
 *
 * Le motif attendu — « la barre apparaît dès que le bouton du bandeau sort de
 * l'écran » — s'obtient d'ordinaire avec un `IntersectionObserver`, donc un îlot
 * client sur le chemin du LCP de la surface qui génère le revenu. Une barre
 * `sticky` posée en **dernier enfant** de la page produit le même service pour
 * zéro octet de JavaScript : tant que le conteneur déborde de la fenêtre, elle
 * reste collée au bas de l'écran ; arrivée en fin de page, elle se range à sa
 * place et libère la vue. La mesure vit dans `styles/components/salon.css`.
 *
 * Au-delà de 48 rem, elle disparaît : le gabarit du salon porte déjà un
 * « Prendre rendez-vous » permanent dans son en-tête (`salon-shell.tsx`, #1045),
 * et BM-VITRINE-04 accepte explicitement cette forme-là. Deux appels à l'action
 * collants sur le même écran se disputeraient l'attention.
 *
 * ## Le doublon, et ce qu'on en fait
 *
 * Le bandeau porte déjà le même lien vers la même page. Deux liens de même nom
 * vers la même destination sont conformes — c'est l'inverse que WCAG 2.4.4
 * proscrit, deux noms pour deux destinations différentes. Le nombre de
 * prestations, lui, n'est pas répété à la voix : c'est un repère visuel, et le
 * catalogue au-dessus le dit déjà mieux, rubrique par rubrique.
 *
 * Server Component : un lien et un compte. Seul `LinkPending` est un îlot, et il
 * ne peint rien avant le clic (#830).
 *
 * ## La langue (#846)
 *
 * Le compte de prestations est une **forme plurielle**, et c'est ICU qui
 * l'accorde : le français et l'anglais ne rangent pas les mêmes nombres dans les
 * mêmes catégories, et un ternaire `=== 1` écrit ici aurait figé la règle
 * française dans les deux langues. L'appel à l'action, lui, vient du registre
 * des sorties publiques, dans la langue résolue — la même chaîne que l'en-tête
 * du gabarit et que le bandeau d'identité.
 */
export function SalonBookingBar({ href, serviceCount }: SalonBookingBarProps) {
  // Appelés avant le retour anticipé : un crochet de React ne se saute pas
  // (`react-hooks/rules-of-hooks`), et ces deux-là en sont.
  const t = useTranslations('booking');
  const locale = useLocale();

  if (href === null || serviceCount === 0) {
    return null;
  }

  return (
    <div className="spa-salon-bookbar">
      <p aria-hidden="true" className="spa-salon-bookbar__count">
        {t('salon.bookingBar.serviceCount', { count: serviceCount })}
      </p>

      <Link className="spa-button spa-button--accent spa-salon-bookbar__action" href={href}>
        <span className="spa-button__label">{publicExitLabels(locale).reservation}</span>
        <LinkPending />
      </Link>
    </div>
  );
}
