'use client';

import type { PublicService } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { groupServicesByCategory } from '@/components/salon/group-services';
import { Icon } from '@/components/ui/icon';
import { Tabs, tabPanelProps } from '@/components/ui/tabs';
import { formatDuration, formatMoney, type DisplayLocale } from '@/lib/format';

/** Préfixe des `id` d'onglets et de panneaux de rubriques, à cette étape. */
const CATEGORY_TABS_PREFIX = 'prestation-rubrique';

interface ServiceChoiceProps {
  readonly services: readonly PublicService[];
  /** `null` : aucune prestation retenue — aucune ligne n'est cochée. */
  readonly selectedServiceId: string | null;
  /**
   * Le pays de l'établissement (`PublicTenant.address.country`), pour la
   * **région** des durées et des tarifs — #846.
   *
   * Facultatif : l'écran qui ne le renseigne pas garde le repli documenté de
   * `lib/format.ts`, et aucun appelant n'a à changer de signature pour ce
   * ticket.
   */
  readonly countryCode?: string | null | undefined;
  readonly onSelect: (serviceId: string) => void;
}

/**
 * Le choix de la prestation — des rubriques en onglets, des prestations en
 * lignes (#741, refondu par #1048).
 *
 * ## Ce que l'audit `d20260918-1` a relevé
 *
 * Trois cartes à rond radio *« sans regroupement par catégorie alors que la
 * vitrine en a deux »*, et une liste qui ne tirait pas parti de la largeur au
 * bureau. Quatre motifs du benchmark le disent autrement
 * (`docs/design/benchmark/parcours-client.md`) :
 *
 * - `BM-SERVICE-01` — *« une prestation, c'est une ligne : nom, durée, prix,
 *   action »*, et *« aucune photo dans la ligne »* ;
 * - `BM-SERVICE-02` et `BM-SERVICE-05` — les rubriques en rangée d'onglets, avec
 *   l'effectif de chacune ;
 * - `BM-SERVICE-06` — *« la prestation choisie se voit sans ambiguïté »*,
 *   autrement que par la seule couleur, et *« la catégorie porte aussi la
 *   marque »* : l'onglet de la rubrique qui contient la prestation retenue porte
 *   une coche (#1079). La coche de la ligne, elle, part avec le panneau fermé —
 *   sans celle de l'onglet, changer de rubrique effacerait de l'écran toute
 *   trace du choix fait.
 *
 * ## Le regroupement vient de la vitrine, et n'est pas réécrit ici
 *
 * `groupServicesByCategory` (`components/salon/group-services.ts`) est déjà le
 * seul endroit où l'ordre d'affichage du catalogue est décidé : rubriques dans
 * l'ordre de l'API, prestations non classées en dernier. Le tunnel le **consomme**
 * plutôt que d'en poser une seconde version — deux découpages du même catalogue
 * finiraient par diverger, et la cliente verrait ses prestations rangées d'une
 * façon sur la vitrine et d'une autre à l'étape suivante.
 *
 * `Tabs` (#1044) porte le motif « tabs » de l'APG — un seul arrêt de tabulation,
 * les flèches d'un onglet à l'autre, la rangée qui défile horizontalement à
 * 360 px. La vitrine l'emploie pour les mêmes rubriques (`catalog-categories.tsx`) :
 * les deux surfaces se lisent donc pareil.
 *
 * **Une seule rubrique n'a pas d'onglet** : un onglet unique n'ouvre aucun choix.
 * La `<legend>` « Prestation » redevient alors visible, comme avant #1048.
 *
 * ## Pourquoi les boutons radio restent, et pourquoi ils ne se voient plus
 *
 * La sélection reste un `radiogroup` de contrôles **natifs** : le groupe, la
 * position (« 2 sur 5 ») et la navigation aux flèches viennent avec, sans un seul
 * attribut `aria` ni un gestionnaire de touche à écrire. Mais la pastille du
 * navigateur n'est plus le signal visuel de l'état retenu — l'issue demande
 * qu'elle *« disparaisse visuellement, le rôle radio restant »*. Elle est donc
 * décalée hors de l'écran, et c'est une **coche** qui la remplace, à droite de la
 * ligne : un signe non chromatique, comme WCAG 1.4.1 l'exige en plus du cadre et
 * du fond d'accent.
 *
 * Le contrôle reste focalisable — il n'est pas `display: none` —, et la feuille
 * porte l'anneau de focus sur la ligne entière (`booking.css`).
 *
 * ## Ce que la ligne ne montre pas
 *
 * Ni photo (`BM-VISUEL-03`), ni praticiens : ceux-ci se choisissent juste en
 * dessous, et les répéter par prestation doublerait la même liste à l'écran. Ni
 * bouton « Choisir » : c'est la ligne qui est la cible, et l'action primaire de
 * l'étape est celle de la barre basse (#1047).
 *
 * ## La langue (#846)
 *
 * Ce que l'établissement a saisi — nom de prestation, description, nom de
 * rubrique — s'affiche **tel quel** : le catalogue d'un salon n'est pas un
 * texte d'interface, et le traduire reviendrait à réécrire son offre. Ne
 * viennent du catalogue de messages que les mots du produit : la légende du
 * groupe, le nom de la rangée d'onglets, les deux préfixes que seul un lecteur
 * d'écran entend, et l'état vide.
 *
 * Durée et tarif passent par `lib/format.ts` avec la langue du lecteur et le
 * pays de l'établissement — « 1 h 00 » et « 1 hr », « 35,00 € » et « €35.00 »
 * sont le même fait dit deux fois.
 */
export function ServiceChoice({
  services,
  selectedServiceId,
  countryCode,
  onSelect,
}: ServiceChoiceProps) {
  const t = useTranslations('booking');
  const display: DisplayLocale = { locale: useLocale(), countryCode: countryCode ?? null };
  // Le titre de la rubrique fictive est le seul mot du groupement qui s'affiche,
  // et il se traduit : il devient l'onglet et la `<legend>` du groupe (#846).
  // Les autres titres sont ceux des rubriques du salon, et ne bougent pas.
  const sections = groupServicesByCategory(services, t('salon.catalog.unclassified'));
  const [openSection, setOpenSection] = useState(
    () =>
      // La rubrique qui porte la prestation déjà retenue, et non la première :
      // on revient sur cette étape avec un brouillon, et l'onglet ouvert doit
      // montrer ce qui a été choisi plutôt que de le cacher derrière un onglet
      // fermé (`BM-TUNNEL-08`, « la cliente retrouve la même étape avec les mêmes
      // choix »).
      sections.find((section) =>
        section.services.some((service) => service.id === selectedServiceId),
      )?.key ??
      sections[0]?.key ??
      '',
  );

  if (services.length === 0) {
    // « Ça charge » et « il n'y a rien » ne sont pas le même écran : le catalogue
    // est arrivé, il est vide, et l'écran le dit (skill web-frontend §6). C'est
    // le message que portait l'`emptyLabel` du sélecteur.
    return (
      <div className="spa-card spa-card--empty">
        <p className="spa-empty-state__title">{t('tunnel.serviceChoice.emptyTitle')}</p>
        <p className="spa-empty-state__description">
          {t('tunnel.serviceChoice.emptyDescription')}
        </p>
      </div>
    );
  }

  if (sections.length < 2) {
    return (
      <ServiceGroup
        display={display}
        legend={t('tunnel.serviceChoice.legend')}
        legendHidden={false}
        onSelect={onSelect}
        selectedServiceId={selectedServiceId}
        services={services}
      />
    );
  }

  return (
    <div className="spa-booking__services-block">
      <Tabs
        idPrefix={CATEGORY_TABS_PREFIX}
        items={sections.map((section) => ({
          id: section.key,
          label: section.title,
          count: section.services.length,
          // `BM-SERVICE-06` — « la catégorie porte aussi la marque » : l'onglet
          // de la rubrique qui porte la prestation retenue se distingue de ses
          // voisins, ouvert ou non. Sans lui, changer d'onglet efface de l'écran
          // toute trace du choix — le CTA devenu actif mis à part (#1079).
          marked: section.services.some((service) => service.id === selectedServiceId),
        }))}
        label={t('tunnel.serviceChoice.tabsLabel')}
        // La coche est décorative ; c'est cette phrase que le lecteur d'écran
        // entend à la suite du libellé et de l'effectif. Elle nomme la
        // prestation comme le reste de l'étape la nomme (`ds:libelles`).
        markedLabel={t('tunnel.serviceChoice.tabsMarked')}
        onChange={setOpenSection}
        value={openSection}
      />

      {sections.map((section) => (
        // Un `<div>` sans règle d'affichage : `hidden` de la feuille de l'agent
        // utilisateur suffit à le fermer, et le contrôle radio d'un panneau
        // fermé cesse d'être focalisable — la navigation aux flèches du
        // `radiogroup` ne sort donc jamais de la rubrique ouverte, alors que la
        // prestation retenue, elle, reste cochée où qu'elle soit.
        <div
          key={section.key}
          {...tabPanelProps(CATEGORY_TABS_PREFIX, section.key)}
          hidden={section.key !== openSection}
        >
          <ServiceGroup
            display={display}
            // Le panneau est déjà nommé par son onglet (`aria-labelledby`) : un
            // titre visible répéterait le mot qu'on vient de toucher. La
            // `<legend>` reste dans le document pour que le groupe de boutons
            // radio garde un nom. C'est le nom de la rubrique **du salon**, et
            // il ne se traduit pas.
            legend={section.title}
            legendHidden
            onSelect={onSelect}
            selectedServiceId={selectedServiceId}
            services={section.services}
          />
        </div>
      ))}
    </div>
  );
}

interface ServiceGroupProps {
  readonly services: readonly PublicService[];
  readonly selectedServiceId: string | null;
  readonly legend: string;
  readonly legendHidden: boolean;
  /** Composé une fois par `ServiceChoice` : deux lectures diraient deux prix. */
  readonly display: DisplayLocale;
  readonly onSelect: (serviceId: string) => void;
}

/** Les lignes d'une rubrique — un `radiogroup` nommé par sa `<legend>`. */
function ServiceGroup({
  services,
  selectedServiceId,
  legend,
  legendHidden,
  display,
  onSelect,
}: ServiceGroupProps) {
  const t = useTranslations('booking');

  return (
    <fieldset className="spa-booking__services">
      <legend
        className={legendHidden ? 'spa-visually-hidden' : 'spa-booking__services-legend'}
      >
        {legend}
      </legend>

      {services.map((service) => (
        // Le `<label>` **enveloppe** son contrôle : le nom accessible du bouton
        // radio est alors tout ce que la ligne porte — « Massage suédois, Durée :
        // 1 h 00, Tarif : 35,00 €, Détente profonde… » —, et toute la ligne est
        // cliquable, y compris au doigt.
        <label className="spa-booking__service" key={service.id}>
          <input
            className="spa-booking__service-input"
            type="radio"
            name="prestation"
            value={service.id}
            checked={service.id === selectedServiceId}
            onChange={() => {
              onSelect(service.id);
            }}
          />

          <span className="spa-booking__service-main">
            <span className="spa-booking__service-name">{service.name}</span>

            {/* La durée en retrait, comme sur la ligne de la vitrine
                (`.spa-salon-service__meta`) : le prix décide, elle qualifie. Le
                préfixe est donné au lecteur d'écran et à lui seul — « 1 h 00 »
                se comprend d'un coup d'œil dans la ligne, mais s'entend comme un
                nombre sans objet. */}
            <span className="spa-booking__service-meta">
              <span className="spa-visually-hidden">
                {t('tunnel.serviceChoice.durationPrefix')}
                {/* L'espace est écrit à part : JSX efface celui qui borde une
                    fin de ligne, et « Durée :1 h 00 » s'entendrait d'un bloc. */}
                {' '}
              </span>
              {formatDuration(service.durationMinutes, display)}
            </span>

            {service.description === null ? null : (
              <span className="spa-booking__service-description">{service.description}</span>
            )}
          </span>

          <span className="spa-booking__service-aside">
            <span className="spa-booking__service-price">
              <span className="spa-visually-hidden">
                {t('tunnel.serviceChoice.pricePrefix')}
                {' '}
              </span>
              {formatMoney(service.price, display)}
            </span>

            {/* La coche — le signal non chromatique de l'état retenu, celui qui
                remplace la pastille du navigateur. Décorative : l'état est déjà
                porté par le bouton radio qu'enveloppe ce `<label>`, et un lecteur
                d'écran annoncerait sinon deux fois la même chose. */}
            <span className="spa-booking__service-check" aria-hidden="true">
              <Icon name="check" className="spa-booking__service-check-mark" />
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
