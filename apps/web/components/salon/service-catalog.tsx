import type { PublicService } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';

import { formatDuration, formatMoney, type DisplayLocale } from '@/lib/format';
import fr from '@/messages/fr/booking.json';

import { serviceBookingHref } from './booking-link';
import { CatalogCategories } from './catalog-categories';
import { groupServicesByCategory } from './group-services';
import type { SalonContactAction } from './salon-contact';

/** Identifiant du titre de section, repris par `aria-labelledby` de la page. */
export const CATALOG_HEADING_ID = 'catalogue';

/** Préfixe des `id` d'onglets et de panneaux de rubriques. */
const CATEGORY_TABS_PREFIX = 'rubrique';

/**
 * Ce que la ligne affiche à la place des noms de praticiens quand il n'y en a
 * aucun (#765), en français.
 *
 * Écrit une fois et exporté : l'aperçu du back-office réemploie ce composant et
 * annonce la mention à la gérante avant qu'elle ne la cherche dans la grille. Un
 * second écran qui la recopierait serait un second libellé à faire diverger.
 *
 * @deprecated Transitoire (#846). Le catalogue le tient désormais, et la ligne
 * du catalogue public le lit par `t('salon.catalog.unstaffed')` : cette
 * constante n'est plus là que pour les deux surfaces du back-office qui la
 * nomment — `admin/components/service-bookability-badge.tsx` et
 * `admin/catalogue/apercu/page.tsx` —, hors de l'empreinte de ce ticket. Elle
 * disparaît avec leur propre ticket de l'épique #843. Lue dans le catalogue
 * plutôt que réécrite ici : il n'y a qu'une écriture de ce libellé.
 */
export const UNSTAFFED_SERVICE_LABEL: string = fr.salon.catalog.unstaffed;

/**
 * Catalogue public d'un salon, groupé par rubrique (#43, refondu par #1046).
 *
 * **Server Component** : c'est du texte, et c'est la partie indexable de la
 * page. Le seul îlot client est la rangée d'onglets de rubriques
 * (`catalog-categories.tsx`), qui reçoit des panneaux **déjà rendus** ici — pas
 * une ligne de prestation n'est peinte par le navigateur.
 *
 * ## Une prestation, c'est une ligne (BM-SERVICE-01)
 *
 * L'audit `d20260918-1` relève des « cartes sans action, sur une grille qui
 * laisse la moitié droite de l'écran vide à 1280 px ». Le motif du marché est
 * une **ligne dense** : le nom, la durée et les praticiens à gauche, le prix en
 * gras et l'action à droite, aucune vignette (BM-VISUEL-03, BM-VISUEL-04). La
 * grille de cartes a donc laissé place à une liste, et la colonne latérale de
 * la page occupe la largeur qui restait.
 *
 * La description est bornée à deux lignes par la feuille de style
 * (BM-SERVICE-04) : une longue description ne repousse plus les prestations
 * suivantes. Le texte entier reste dans le document — pour les moteurs comme
 * pour les lecteurs d'écran —, seule sa hauteur est contenue.
 *
 * ## Une prestation se choisit depuis la vitrine (BM-VITRINE-05)
 *
 * « On ne choisit rien depuis la vitrine » était le second constat de l'audit.
 * Chaque ligne porte désormais « Choisir », qui ouvre le tunnel **sur cette
 * prestation**, à l'étape du créneau (`booking-link.ts`). Le bouton est en
 * contour et non en aplat : l'écran n'a qu'une seule action pleine, celle du
 * bandeau (BM-VISUEL-02).
 *
 * Il n'apparaît pas sur une prestation que personne ne pratique : le moteur de
 * disponibilité ne proposera aucun créneau pour elle, et l'y envoyer serait
 * offrir une action qui ne peut pas s'exercer — la règle que #773 a posée pour
 * l'état vide du catalogue vaut ligne à ligne.
 *
 * ## Ce que chaque ligne montre, et pourquoi
 *
 * Nom, description, durée facturée, praticiens et prix. Les tampons de
 * préparation et de remise en état ne sont pas dans `PublicService` et n'ont
 * pas à l'être : ils décrivent la cadence interne du salon
 * (`publicServiceSchema`). La durée affichée est donc celle du soin, celle que
 * la cliente paie.
 *
 * Les montants passent par `formatMoney`, qui part d'un entier et d'un code
 * devise — aucun flottant ne traverse le calcul (CLAUDE.md, règles de code).
 *
 * ## Une prestation sans praticien le dit, au lieu de se taire (#765)
 *
 * La ligne « Praticiens : » était simplement **masquée** quand `staff` était
 * vide. La carte devenait alors indiscernable d'une prestation réservable —
 * même titre, même durée, même prix — et l'absence ne se lisait qu'en creux. Le
 * back-office énonce pourtant la règle sur la fiche de la prestation : « Tant
 * qu'aucun praticien ne pratique cette prestation, le moteur de disponibilité ne
 * proposera aucun créneau pour elle » (`admin/components/service-staff-panel.tsx`).
 * La vitrine porte la même condition, dans les mots de la cliente.
 *
 * C'est le sens de `staff` dans le contrat public : il ne liste que les
 * praticiens **actifs** de la prestation (`PUBLIC_SERVICE_SELECT`). Vide, il ne
 * veut donc pas seulement dire « personne n'est affecté », mais « personne ne
 * peut honorer ce soin ». La mention ne repose sur aucune couleur — le texte
 * porte le sens à lui seul (WCAG 1.4.1).
 *
 * ## Un catalogue vide ne donne plus d'ordre irréalisable (#773)
 *
 * L'état vide écrivait « Contactez-le directement pour connaître son offre »
 * sans distinguer le salon qui a publié un numéro de celui qui n'a rien publié
 * du tout. L'instruction est désormais liée à ce qui la rend possible : quand le
 * salon a publié un moyen d'être joint, l'état vide porte l'action elle-même —
 * un vrai `tel:` ou `mailto:` (`salon-contact.ts`), comme le dessine
 * `docs/design/appointments/states.md` pour l'étape service. Sinon il se borne
 * au constat.
 *
 * ## La langue (#846)
 *
 * Les mots de l'interface — le titre de section, les préfixes de lecture
 * d'écran, l'état vide, « Choisir » — viennent du catalogue, sous
 * `salon.catalog`. **Rien de ce que le salon a saisi n'y passe** : le nom d'une
 * prestation, sa description, le nom d'une rubrique et celui d'un praticien
 * s'affichent tels quels.
 *
 * `useTranslations` et non `getTranslations` : ce composant n'est pas
 * asynchrone, et le crochet fonctionne dans un Server Component.
 *
 * Les durées et les prix passent par `lib/format.ts` avec la langue résolue. Le
 * `countryCode` y est `null`, et **ce n'est pas un oubli** : ce composant ne
 * reçoit pas l'établissement — l'aperçu du back-office le monte sur un catalogue
 * seul —, et le brief de l'épique interdit d'inventer un pays qu'on n'a pas sous
 * la main. La région tombe alors sur le repli figé de `lib/format.ts`.
 */
interface ServiceCatalogProps {
  readonly services: readonly PublicService[];
  /**
   * Comment joindre le salon, quand il a publié de quoi le faire (#773).
   *
   * Facultatif, et par défaut absent : l'aperçu du back-office réemploie ce
   * catalogue (`admin/catalogue/apercu`) et n'a personne à faire appeler — la
   * gérante est déjà chez elle. Son état vide reste donc le constat seul.
   */
  readonly contact?: SalonContactAction | null;
  /**
   * Chemin du tunnel de réservation, d'où partent les boutons « Choisir » (#1046).
   *
   * Facultatif pour la même raison que `contact` : l'aperçu du back-office rend
   * le catalogue pour le montrer, pas pour y réserver. Sans lui, les lignes
   * gardent leur prix et leur durée, sans action — exactement ce que la gérante
   * regardait jusqu'ici.
   */
  readonly reservationPath?: string | null;
}

export function ServiceCatalog({
  services,
  contact = null,
  reservationPath = null,
}: ServiceCatalogProps) {
  const t = useTranslations('booking');
  const sections = groupServicesByCategory(services, t('salon.catalog.unclassified'));
  const onlySection = sections.length === 1 ? sections[0] : undefined;

  return (
    <section className="spa-salon__section" aria-labelledby={CATALOG_HEADING_ID}>
      <h2 className="spa-salon__section-title" id={CATALOG_HEADING_ID}>
        {t('salon.catalog.title')}
      </h2>

      {sections.length === 0 ? (
        // Un catalogue vide n'est pas une erreur : un salon qui vient de
        // s'inscrire existe, et sa page doit le dire plutôt que de rester
        // blanche (skill web-frontend §6).
        <div className="spa-card spa-card--empty">
          <p className="spa-empty-state__title">{t('salon.catalog.emptyTitle')}</p>
          <p className="spa-empty-state__description">
            {contact === null
              ? t('salon.catalog.emptyDescription')
              : t('salon.catalog.emptyDescriptionWithContact')}
          </p>
          {contact === null ? null : (
            // Un `<a>` et non un `<button>` : `tel:` et `mailto:` sont des
            // destinations, et le composeur du téléphone est ce qui doit s'ouvrir
            // au doigt. C'est aussi ce qui garde l'état vide sans îlot client.
            <a className="spa-button spa-button--neutral" href={contact.href}>
              {contact.label}
            </a>
          )}
        </div>
      ) : onlySection !== undefined ? (
        // Une seule rubrique : son titre se lit, et aucun onglet n'est offert —
        // un onglet unique n'ouvre aucun choix.
        <section className="spa-salon__category" aria-labelledby={`rubrique-${onlySection.key}`}>
          <h3 className="spa-salon__category-title" id={`rubrique-${onlySection.key}`}>
            {onlySection.title}
          </h3>
          <ServiceList services={onlySection.services} reservationPath={reservationPath} />
        </section>
      ) : (
        <CatalogCategories
          idPrefix={CATEGORY_TABS_PREFIX}
          panels={sections.map((section) => ({
            id: section.key,
            label: section.title,
            count: section.services.length,
            // Le panneau est nommé par son onglet (`aria-labelledby`) : un titre
            // visible répéterait le mot qu'on vient de toucher. Il reste dans le
            // document, masqué à l'œil, pour que la hiérarchie de titres — celle
            // que lit un moteur et que parcourt un lecteur d'écran — ne perde
            // pas ses rubriques.
            content: (
              <>
                <h3 className="spa-visually-hidden">{section.title}</h3>
                <ServiceList services={section.services} reservationPath={reservationPath} />
              </>
            ),
          }))}
        />
      )}
    </section>
  );
}

interface ServiceListProps {
  readonly services: readonly PublicService[];
  readonly reservationPath: string | null;
}

function ServiceList({ services, reservationPath }: ServiceListProps) {
  const t = useTranslations('booking');
  const locale = useLocale();
  // Voir le bloc de tête : la vitrine ne passe pas l'établissement à ce
  // composant, et un pays deviné serait pire qu'un pays absent.
  const display: DisplayLocale = { locale, countryCode: null };

  return (
    <ul className="spa-salon__services">
      {services.map((service) => {
        // Une prestation que personne ne pratique n'a pas de créneau à offrir :
        // pas de bouton, plutôt qu'un bouton qui mène à une impasse (#773).
        const bookingHref =
          reservationPath === null || service.staff.length === 0
            ? null
            : serviceBookingHref(reservationPath, service.id);

        return (
          // L'ancre porte le slug de la prestation : c'est elle que les données
          // structurées désignent dans l'`url` de chaque offre, et un lien
          // profond vers une prestation doit aboutir quelque part.
          <li className="spa-salon-service" id={service.slug} key={service.id}>
            <div className="spa-salon-service__main">
              <h4 className="spa-salon-service__name">{service.name}</h4>

              <p className="spa-salon-service__meta">
                <span>
                  <span className="spa-visually-hidden">{t('salon.catalog.durationLabel')} </span>
                  {formatDuration(service.durationMinutes, display)}
                </span>
                {service.staff.length === 0 ? (
                  // Pas de préfixe « Praticiens : » ici : la mention se suffit,
                  // et le lecteur d'écran entendrait sinon « Praticiens : aucun
                  // praticien ».
                  <span>{t('salon.catalog.unstaffed')}</span>
                ) : (
                  <span>
                    <span className="spa-visually-hidden">{t('salon.catalog.staffLabel')} </span>
                    {service.staff.map((member) => member.displayName).join(', ')}
                  </span>
                )}
              </p>

              {service.description === null ? null : (
                <p className="spa-salon-service__description">{service.description}</p>
              )}
            </div>

            <div className="spa-salon-service__aside">
              <p className="spa-salon-service__price">
                <span className="spa-visually-hidden">{t('salon.catalog.priceLabel')} </span>
                {formatMoney(service.price, display)}
              </p>

              {bookingHref === null ? null : (
                // Le nom accessible porte la prestation : une page de vingt
                // liens tous nommés « Choisir » ne se navigue pas au clavier
                // ni au lecteur d'écran (WCAG 2.4.4). Le nom de la prestation
                // est du contenu de salon — il ne traverse pas le catalogue, et
                // le tiret qui l'introduit n'est que de la ponctuation (#846).
                <Link className="spa-button spa-button--neutral spa-salon-service__action" href={bookingHref}>
                  {t('salon.catalog.choose')}
                  <span className="spa-visually-hidden"> — {service.name}</span>
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
