import type { PublicService } from '@spa/shared';
import { useTranslations } from 'next-intl';

import { groupServicesByCategory } from '@/components/salon/group-services';
import type { BookingStep } from '@/lib/booking/draft';

/** Les journées dessinées dans la bande — de quoi remplir la rangée visible. */
const SKELETON_DAYS = 7;

/** Les horaires dessinés sous la bande — deux rangées pleines au bureau. */
const SKELETON_SLOTS = 12;

/** Les lignes du récapitulatif : prestation, praticien, date, coordonnées. */
const SKELETON_RECAP_ROWS = 4;

interface BookingStepSkeletonProps {
  readonly step: BookingStep;
  /**
   * Le catalogue, pour que la liste de prestations en porte le **compte réel**.
   *
   * C'est ce qui sépare un squelette d'une réserve de hauteur : quatre lignes
   * grises devant six prestations laissent la page sauter à l'arrivée du
   * contenu, ce que `BM-ECRAN-01` interdit précisément.
   */
  readonly services: readonly PublicService[];
  /**
   * La prestation que l'adresse désigne, ou `null`.
   *
   * Elle décide de la rubrique ouverte, donc du nombre de lignes dessinées —
   * même lecture que `ServiceChoice`, qui ouvre la rubrique portant le choix
   * déjà fait plutôt que la première.
   */
  readonly selectedServiceId: string | null;
}

/**
 * Le squelette de l'étape, tant que le tunnel n'est pas hydraté (#1055).
 *
 * ## Ce qu'il remplace
 *
 * Une carte grise de trois lignes, la même à toutes les étapes. L'audit
 * `d20260918-1` l'a relevée deux fois : à 1 280 px, ouvrir
 * `?etape=creneau&prestation=…` montrait *« la pastille "Prestation" active et
 * un rectangle blanc vide de 100 px »* ; à 360 px, l'étape prestation s'ouvrait
 * sur *« ce même cadre blanc vide, puis la liste apparaît et pousse le reste de
 * la page »*.
 *
 * `BM-ECRAN-01` (`docs/design/benchmark/transverse.md`) veut l'inverse :
 * *« pendant le chargement, la page a déjà sa forme — des blocs gris aux formes
 * des cartes, du récapitulatif et du bouton final, remplacés en place par le
 * contenu »*. Et `states.md` le redit en règle générale : *« squelettes qui
 * reprennent la forme du contenu à venir, jamais un simple spinner centré »*,
 * *« pas de saut de mise en page à l'arrivée des données »*.
 *
 * ## Comment la hauteur est tenue
 *
 * Le squelette n'invente aucune boîte : il monte **les classes de structure de
 * l'étape réelle** — `.spa-booking__service`, `.spa-slot-grid__row`,
 * `.spa-field`, `.spa-booking__bar` — et n'y remplace que le texte, par des
 * `.spa-booking__skeleton-text` en `inline-block` de `0.7em`. Un `inline-block`
 * plus court que la ligne ne la fait pas grandir : la hauteur du bloc reste
 * celle du texte qui arrivera, corps et interligne compris, sans qu'aucune
 * valeur ne soit recopiée dans la feuille — elle suivrait mal le jour où le
 * corps d'un libellé change.
 *
 * Les deux boîtes qui ne portent pas de texte — la journée de la bande, la
 * pastille d'horaire — ont leur hauteur écrite en jetons, à l'identique de la
 * vraie (`booking.css`), et `tests/booking-skeleton-reserve.test.mjs` compare
 * les deux calculs.
 *
 * ## Ce n'est pas `loading.tsx`
 *
 * `reservation/loading.tsx` est le repli de Suspense pendant que le **serveur**
 * compose la page : il ne connaît ni l'établissement ni le catalogue, et ne peut
 * donc pas dessiner une étape. Celui-ci est rendu par le tunnel lui-même, une
 * fois les deux connus, sur l'étape que `initial-draft.ts` a lue dans l'adresse.
 *
 * Aucun état, aucun écouteur : le composant ne pèse que son balisage, et le
 * `"use client"` du tunnel qui le monte lui suffit.
 *
 * ## La langue (#846)
 *
 * Le seul texte de ce dessin est ce que le lecteur d'écran entend pendant que
 * l'étape se pose — une phrase **par étape**, sous `tunnel.skeleton.loading`, et
 * non un « Chargement… » unique : `states.md` conçoit l'état de chargement par
 * écran, et l'annonce doit dire ce qui arrive — des prestations, des
 * disponibilités, un récapitulatif —, faute de quoi elle ne vaut pas mieux que
 * le silence.
 *
 * `SlotPicker` lit **la même clé** — `tunnel.skeleton.loading.creneau` — pour
 * l'attente qui suit l'hydratation, comme il monte déjà le même
 * `SlotGridSkeleton` : deux formulations pour un même chargement diraient à
 * l'oreille que l'écran a changé alors qu'il attend toujours.
 */
export function BookingStepSkeleton({
  step,
  services,
  selectedServiceId,
}: BookingStepSkeletonProps) {
  const t = useTranslations('booking');

  return (
    <div className="spa-booking__step spa-booking__step--skeleton" aria-busy="true">
      {/* Clé construite : les cinq annonces ne se distinguent que par l'étape.
          L'`as` désigne une clé réelle, comme dans
          `components/ui/locale-switcher.tsx`. */}
      <span className="spa-visually-hidden">
        {t(`tunnel.skeleton.loading.${step}` as 'tunnel.skeleton.loading.prestation')}
      </span>

      {step === 'prestation' ? (
        <ServiceListSkeleton services={services} selectedServiceId={selectedServiceId} />
      ) : step === 'creneau' ? (
        <div className="spa-slot-picker">
          <DateBandSkeleton />
          <div className="spa-slot-picker__day">
            <SlotGridSkeleton />
          </div>
        </div>
      ) : step === 'coordonnees' ? (
        <ContactSkeleton />
      ) : (
        <RecapSkeleton />
      )}

      {/* La correction nommée, dans le flux — « Changer de prestation » à
          l'étape « Créneau », « Changer de créneau » aux « Coordonnées »
          (`slot-step.tsx`, `contact-step.tsx`). Les deux autres étapes n'en ont
          pas : la première n'a rien derrière elle, le récapitulatif corrige par
          ses propres liens, et la dessiner y réserverait une hauteur que le
          contenu ne prendra jamais. */}
      {step === 'creneau' || step === 'coordonnees' ? (
        <div className="spa-booking__actions">
          <span className="spa-booking__skeleton-button spa-booking__skeleton-button--inline spa-skeleton" />
        </div>
      ) : null}

      {/* La confirmation n'a pas de barre basse : le tunnel est terminé, et
          `wireframes.md` y retire l'action primaire collante. */}
      {step === 'confirmation' ? null : <ActionBarSkeleton step={step} />}
    </div>
  );
}

/**
 * La grille d'horaires en attente — `states.md` étape 3.
 *
 * Exportée parce que `SlotPicker` la monte aussi, pour l'attente qui **suit**
 * l'hydratation : l'étape « Créneau » interroge les disponibilités à son
 * montage, et sans ce partage la cliente verrait un squelette de pastilles céder
 * la place à un autre squelette, de trois lignes celui-là.
 *
 * La bande de dates n'y figure pas : elle se pose sans le serveur — ce sont des
 * dates — et `states.md` demande qu'elle reste **interactive** pendant le
 * chargement, *« pour changer de jour sans attendre »*. Elle n'est dessinée
 * qu'ici, avant hydratation, où rien n'est encore opérable.
 */
export function SlotGridSkeleton() {
  return (
    <div className="spa-slot-grid">
      <div className="spa-slot-grid__row">
        {/* `spa-card__meta` avec elle, comme sur la vraie rangée
            (`slot-picker.tsx`) : c'est cette classe qui porte le corps `sm` de
            l'en-tête, et la ligne serait sinon plus haute ici que là. */}
        <span className="spa-slot-grid__rowheader spa-card__meta">
          <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--sm" />
        </span>

        {range(SKELETON_SLOTS).map((index) => (
          <span className="spa-booking__skeleton-slot spa-skeleton" key={index} />
        ))}
      </div>
    </div>
  );
}

/** La rangée de journées — chevrons, mois, et les blocs de date qu'on balaye. */
function DateBandSkeleton() {
  return (
    <div className="spa-date-band">
      <div className="spa-date-band__nav">
        <span className="spa-booking__skeleton-control spa-booking__skeleton-control--square spa-skeleton" />
        <span className="spa-booking__skeleton-control spa-booking__skeleton-control--grow spa-skeleton" />
        <span className="spa-booking__skeleton-control spa-booking__skeleton-control--square spa-skeleton" />
      </div>

      <div className="spa-date-band__grid">
        <div className="spa-date-band__row">
          {range(SKELETON_DAYS).map((index) => (
            <span className="spa-booking__skeleton-day spa-skeleton" key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}

interface ServiceListSkeletonProps {
  readonly services: readonly PublicService[];
  readonly selectedServiceId: string | null;
}

/**
 * Les lignes de prestation, au compte exact de la rubrique qui va s'ouvrir.
 *
 * Le découpage vient de `groupServicesByCategory`, consommé ici comme
 * `ServiceChoice` le consomme : deux lectures du même catalogue donneraient deux
 * hauteurs, et la seconde ferait sauter la page.
 */
function ServiceListSkeleton({ services, selectedServiceId }: ServiceListSkeletonProps) {
  const sections = groupServicesByCategory(services);
  const open =
    sections.find((section) =>
      section.services.some((service) => service.id === selectedServiceId),
    ) ?? sections[0];

  const rows = (
    <div className="spa-booking__services">
      {(open?.services ?? []).map((service) => (
        <div className="spa-booking__service" key={service.id}>
          <span className="spa-booking__service-main">
            <span className="spa-booking__service-name">
              <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--lg" />
            </span>
            <span className="spa-booking__service-meta">
              <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--md" />
            </span>
            {/* La description, ligne par ligne réelle : `ServiceChoice` ne la
                rend que si la prestation en porte une, et la taire ici
                laisserait la ligne grandir d'une ligne à l'arrivée du contenu —
                le saut même que ce squelette supprime. Le catalogue est là, la
                question se tranche prestation par prestation. */}
            {service.description === null ? null : (
              <span className="spa-booking__service-description">
                <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--lg" />
              </span>
            )}
          </span>

          <span className="spa-booking__service-aside">
            <span className="spa-booking__service-price">
              <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--sm" />
            </span>
            {/* Le rond de sélection, tel quel : décoché, il est déjà un cercle
                vide bordé — le griser ne le rendrait pas plus ressemblant. */}
            <span className="spa-booking__service-check" />
          </span>
        </div>
      ))}
    </div>
  );

  // Une seule rubrique : `ServiceChoice` rend alors le groupe **sans** bloc
  // d'onglets, et sa `<legend>` « Prestation » reste **visible**
  // (`.spa-booking__services-legend`). La taire ici retirait 28 px que le
  // contenu reprend aussitôt — le cas le plus courant, et celui que l'audit a
  // mesuré à 360 px.
  if (sections.length < 2) {
    return (
      <div>
        <span className="spa-booking__services-legend spa-booking__skeleton-legend">
          <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--sm" />
        </span>
        {rows}
      </div>
    );
  }

  return (
    <div className="spa-booking__services-block">
      {/* La rangée d'onglets n'existe qu'à partir de deux rubriques, exactement
          comme dans `ServiceChoice` : la dessiner pour une seule réserverait
          44 px que le contenu ne prendra jamais. */}
      <span className="spa-booking__skeleton-tabs spa-skeleton" />
      {rows}
    </div>
  );
}

/**
 * Les champs des coordonnées.
 *
 * Aucune donnée ne les attend — le formulaire est local (`states.md` étape 4) —,
 * mais l'hydratation, si : sans ces boîtes, l'étape s'ouvrait sur le même cadre
 * vide que les autres, puis cinq champs poussaient la barre basse d'un écran.
 */
function ContactSkeleton() {
  return (
    <>
      <div className="spa-booking__names">
        <FieldSkeleton />
        <FieldSkeleton />
      </div>
      <FieldSkeleton />
      <FieldSkeleton />
      <FieldSkeleton tall />
      <span className="spa-booking__skeleton-consent spa-skeleton" />
    </>
  );
}

/** La carte du récapitulatif — un terme et sa valeur par ligne. */
function RecapSkeleton() {
  return (
    <div className="spa-card">
      <p className="spa-booking__recap-title">
        <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--md" />
      </p>

      <dl className="spa-booking__recap">
        {range(SKELETON_RECAP_ROWS).map((index) => (
          <div className="spa-booking__recap-row" key={index}>
            <dt className="spa-booking__recap-term">
              <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--md" />
            </dt>
            <dd className="spa-booking__recap-value">
              <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--lg" />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * La barre basse — la ligne de rappel, l'action primaire, ou les deux (#1047).
 *
 * Ni l'une ni l'autre n'est là à toutes les étapes, et `BookingActionBar` le
 * décide par les deux propriétés qu'elle reçoit. Le squelette doit suivre le
 * **même** partage, faute de quoi la barre change de hauteur à l'hydratation, au
 * bas de l'écran et sous le doigt :
 *
 * - `summary` est `null` à « Prestation » — le choix n'y est pas encore retenu —
 *   et au récapitulatif, où ces faits **sont** l'écran. Ailleurs la ligne existe,
 *   et elle vaut une cible tactile de haut sous 64 rem, où elle est visible
 *   (`.spa-booking__bar-summary`, masquée au-delà) ;
 * - l'action primaire manque à « Créneau », qui avance au clic sur un horaire
 *   (`slot-step.tsx`). La dessiner y ajoutait un bouton de 44 px que le contenu
 *   ne reprend jamais — et au-delà de 64 rem, où la ligne de rappel disparaît,
 *   c'était toute la barre qui était en trop.
 *
 * La ligne emprunte la classe réelle plutôt que d'en redéclarer la hauteur :
 * c'est elle qui porte la cible tactile, le corps `sm` et le `display: none` du
 * bureau, et les trois doivent bouger ensemble.
 */
function ActionBarSkeleton({ step }: { readonly step: BookingStep }) {
  const hasSummary = step !== 'prestation' && step !== 'recapitulatif';

  return (
    <div className="spa-booking__bar">
      {hasSummary ? (
        <span className="spa-booking__bar-summary">
          <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--lg" />
        </span>
      ) : null}

      {step === 'creneau' ? null : (
        <span className="spa-booking__bar-action">
          <span className="spa-booking__skeleton-button spa-skeleton" />
        </span>
      )}
    </div>
  );
}

/** Un libellé et son contrôle, à la hauteur d'un `.spa-field` réel. */
function FieldSkeleton({ tall = false }: { readonly tall?: boolean }) {
  return (
    <div className="spa-field">
      <span className="spa-field__label">
        <span className="spa-skeleton spa-booking__skeleton-text spa-booking__skeleton-text--md" />
      </span>
      <span
        className={
          tall
            ? 'spa-booking__skeleton-control spa-booking__skeleton-control--tall spa-skeleton'
            : 'spa-booking__skeleton-control spa-skeleton'
        }
      />
    </div>
  );
}

/** `[0, 1, … n-1]` — les clés de liste d'un dessin sans données. */
function range(count: number): readonly number[] {
  return Array.from({ length: count }, (_unused, index) => index);
}
