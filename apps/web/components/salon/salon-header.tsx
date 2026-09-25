import type { PublicTenant } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';

import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import { LinkPending } from '@/components/ui/link-pending';
import type { DisplayLocale } from '@/lib/format';

import { addressLocality, directionsUrl } from './salon-address';
import { openingStatus } from './opening-hours';
import { publicExitLabels } from './public-exits';
import { telUri } from './salon-contact';

interface SalonHeaderProps {
  readonly tenant: PublicTenant;
  /**
   * Chemin du tunnel de réservation — construit par la page, qui tient les URL —
   * ou `null` quand la réservation en ligne n'est pas ouverte (#773).
   *
   * Le `null` n'est pas une commodité de typage : c'est la seule chose que
   * l'en-tête a besoin de savoir de l'état du catalogue. Un salon sans
   * prestation publiée n'a pas de tunnel où envoyer qui que ce soit, et le
   * chemin n'existe donc pas pour lui — plutôt qu'un chemin valide assorti d'un
   * second drapeau qui dirait de ne pas s'en servir.
   */
  readonly reservationHref: string | null;
  /**
   * L'instant auquel l'état d'ouverture est calculé (#1046).
   *
   * Donné par la page plutôt que lu ici : c'est ce qui rend le bandeau testable
   * sans geler l'horloge du processus, et ce qui garantit que les deux endroits
   * de la page qui parlent des horaires — cette ligne et la carte « Horaires » —
   * parlent du même moment.
   */
  readonly now?: Date;
}

/**
 * Le bandeau d'identité de la vitrine (#43, refondu par #1046).
 *
 * ## Ce qu'il montrait, et ce qui n'allait pas
 *
 * « RÉSERVATION EN LIGNE », le nom, une phrase générique et un bouton — ni
 * adresse, ni état d'ouverture. L'audit `d20260918-1` le relève au titre de
 * `ds:standard` : BM-VITRINE-01 décrit une identité compacte — nom, adresse
 * cliquable, état d'ouverture — que la cliente lit d'un coup d'œil pour vérifier
 * qu'elle est au bon endroit, avant de choisir quoi que ce soit.
 *
 * ## Ce qu'il montre maintenant
 *
 * Un aplat de marque (`--spa-color-surface-brand`) qui porte le monogramme du
 * salon, son nom, et **une ligne d'état** : la ville, puis « Ouvert — ferme à
 * 19:00 » calculé dans le fuseau du salon (BM-VITRINE-02). L'adresse mène à
 * l'itinéraire (BM-VITRINE-07) ; le numéro, quand il existe, ouvre le composeur.
 *
 * L'aplat de marque et non l'accent : l'accent désigne ce qu'on clique
 * (BM-VISUEL-01), et un bandeau d'identité peint en accent passerait pour un
 * bouton géant. Même rôle, et mêmes jetons, que le bandeau de clôture de
 * l'accueil (`home.css`).
 *
 * ## Server Component
 *
 * Rien ici n'a d'état ni d'écouteur, et cette section porte le LCP de la page.
 * Un `"use client"` la ferait rendre deux fois et retarderait le seul élément
 * qui compte pour la mesure (skill web-frontend §1 et §7). L'état d'ouverture
 * est calculé au rendu serveur, à chaque requête — la page est en
 * `force-dynamic` —, ce qui évite l'écart d'hydratation qu'un calcul côté client
 * produirait sur un `Date.now()`.
 *
 * L'appel à l'action reste un `<Link>` et non un `<button>` : c'est une
 * navigation, elle doit pouvoir s'ouvrir dans un nouvel onglet et être suivie
 * par un moteur de recherche jusqu'au tunnel. Au clic, il se dit « en cours »
 * jusqu'à l'arrivée du tunnel (#830) — `LinkPending` y remplace le libellé par
 * un repère, à largeur conservée. C'est le seul îlot client du bandeau, et il ne
 * peint rien avant le clic.
 *
 * Le **libellé** vient du registre des sorties publiques (`public-exits.tsx`) :
 * cet appel à l'action et les barres de sorties nomment la même page, et deux
 * chaînes écrites à deux endroits finissent par diverger. Depuis #846, il est
 * demandé dans la **langue résolue** — `publicExitLabels(locale)` et non la
 * table figée en français, qui n'existe plus que pour les surfaces que l'épique
 * #843 n'a pas encore atteintes.
 *
 * ## La langue (#846)
 *
 * Ce que le bandeau écrit de lui-même — l'accroche, la mention d'itinéraire,
 * « Appeler » — vient du catalogue, sous `salon.hero`. Le **nom du salon** et sa
 * ville, eux, sont du contenu : ils s'insèrent en paramètre de l'accroche et ne
 * se traduisent pas.
 *
 * L'état d'ouverture est calculé par `opening-hours.ts`, à qui la langue **et le
 * traducteur** sont passés : c'est lui qui écrit « Ouvert — ferme à 19:00 »,
 * parce que la phrase dépend de la branche empruntée, mais il ne lit plus le
 * catalogue lui-même (#1142) — un module pur atteignable côté client en aurait
 * embarqué les deux langues entières dans le bundle. Le fuseau, lui, reste celui
 * de l'établissement — la langue n'y touche pas.
 *
 * ## Ce que l'accroche promet, elle le tient (#773)
 *
 * L'accroche annonçait « Découvrez les prestations…, leurs durées et leurs
 * tarifs » et l'action accentuée « Prendre rendez-vous » quel que soit l'état du
 * catalogue. Sur la vitrine d'un salon qui n'a rien publié, les deux étaient
 * faux du même coup. L'accroche dit donc l'état réel, et l'appel à l'action
 * **disparaît** au lieu de se désactiver : un bouton grisé sur une page publique
 * laisse croire qu'il manque une condition à remplir, là où il n'y a rien à
 * faire côté visiteuse. Ce qu'il y a à faire — joindre le salon — est proposé
 * par l'état vide du catalogue, juste en dessous, et seulement si le salon a
 * publié de quoi le joindre (`salon-contact.ts`).
 */
export function SalonHeader({ tenant, reservationHref, now = new Date() }: SalonHeaderProps) {
  const t = useTranslations('booking');
  const locale = useLocale();
  const display: DisplayLocale = { locale, countryCode: tenant.address?.country ?? null };
  const locality = addressLocality(tenant.address);
  const status = openingStatus(tenant.openingHours ?? [], tenant.timezone, now, display, t);
  const directions = tenant.address === undefined ? null : directionsUrl(tenant.name, tenant.address);

  return (
    <header className="spa-salon-hero">
      <div className="spa-salon-hero__identity">
        {/* Ton `accent` et non `brand` : `--spa-avatar--brand` peint la pastille
            de la couleur du bandeau, et le monogramme y disparaîtrait. La paire
            « accent-text sur accent-soft » est vérifiée par
            `tests/contrast.test.mjs`, et se retourne proprement en thème sombre. */}
        <Avatar name={tenant.name} shape="square" tone="accent" size="xl" />
        <div className="spa-salon-hero__naming">
          <h1 className="spa-salon-hero__title">{tenant.name}</h1>

          {/* La ligne d'identité : où, et ouvert ou non. Les deux repères
              peuvent manquer indépendamment — un salon fraîchement inscrit n'a
              ni adresse ni horaires —, et la ligne disparaît alors plutôt que
              de rendre une puce esseulée. */}
          {locality === null && status === null ? null : (
            <p className="spa-salon-hero__facts">
              {locality === null ? null : (
                <span className="spa-salon-hero__fact">
                  <Icon name="pin" />
                  {directions === null ? (
                    locality
                  ) : (
                    // `rel="noreferrer"` autant que `noopener` : la destination
                    // est un tiers, et rien ne l'autorise à savoir de quelle
                    // page du salon la visiteuse arrive.
                    <a
                      className="spa-salon-hero__link"
                      href={directions}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {locality}
                      <span className="spa-visually-hidden">
                        {' '}
                        {t('salon.hero.directions')}
                      </span>
                    </a>
                  )}
                </span>
              )}

              {status === null ? null : (
                // L'état ne repose pas sur la seule couleur : la pastille est
                // décorative, le mot « Ouvert » ou « Fermé » porte le sens
                // (WCAG 1.4.1).
                <span
                  className={`spa-salon-hero__fact spa-salon-hero__status${
                    status.open ? ' spa-salon-hero__status--open' : ''
                  }`}
                >
                  <span aria-hidden="true" className="spa-salon-hero__dot" />
                  {status.label}
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      <p className="spa-salon-hero__lede">
        {reservationHref === null
          ? t('salon.hero.ledeUnavailable', { name: tenant.name })
          : t('salon.hero.ledeBookable', { name: tenant.name })}
      </p>

      {reservationHref === null && tenant.contactPhone === undefined ? null : (
        <div className="spa-salon-hero__actions">
          {reservationHref === null ? null : (
            <Link className="spa-button spa-salon-hero__action" href={reservationHref}>
              <span className="spa-button__label">{publicExitLabels(locale).reservation}</span>
              <LinkPending />
            </Link>
          )}

          {tenant.contactPhone === undefined ? null : (
            // Un `<a>` et non un `<button>` : `tel:` est une destination, et le
            // composeur du téléphone est ce qui doit s'ouvrir au doigt.
            <a
              className="spa-button spa-salon-hero__action spa-salon-hero__action--ghost"
              href={telUri(tenant.contactPhone)}
            >
              <Icon name="phone" />
              {t('salon.hero.call')}
            </a>
          )}
        </div>
      )}
    </header>
  );
}
