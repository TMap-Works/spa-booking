import type { Money, OpeningHoursEntry, PostalAddress, PublicService, PublicTenant } from '@spa/shared';

import { groupServicesByCategory } from './group-services';
import { SCHEMA_ORG_WEEKDAYS } from './opening-hours';

/**
 * Données structurées de la page publique d'un salon (#43).
 *
 * ## Pourquoi du JSON-LD, et pas des microdonnées
 *
 * C'est le format que Google recommande, et le seul qui n'oblige pas à
 * entrelacer le balisage sémantique avec la mise en page : le graphe est un
 * objet, il se teste comme un objet — `buildSalonGraph` ci-dessous est exporté
 * pour cela — là où des attributs `itemprop` dispersés dans le JSX ne se
 * vérifient qu'à l'œil.
 *
 * ## Ce que le graphe porte
 *
 * Un `HealthAndBeautyBusiness` (sous-type de `LocalBusiness`) et son
 * `OfferCatalog`, une rubrique du catalogue par sous-catalogue, une prestation
 * par `Offer`. Les prix y figurent en unité **principale** de la devise, comme
 * schema.org l'exige — un crawler ne sait pas lire « 35,00 € » mais lit
 * `"price": "35.00"`.
 *
 * La conversion est faite ici et non par `formatMoney` de `lib/format.ts` :
 * celle-ci rend une chaîne localisée (virgule décimale, symbole, espace
 * insécable) qu'aucun analyseur n'accepte. Sa place naturelle serait tout de
 * même ce module — c'est le seul du front autorisé à diviser un montant — mais
 * `lib/format.ts` est hors de l'empreinte de fichiers de ce ticket, que deux
 * autres branches se partagent. La remontée est suivie par une issue dédiée ;
 * d'ici là, les décimales sont lues d'`Intl` comme là-bas, et non codées en dur,
 * pour que les deux implémentations ne puissent pas diverger sur une devise à
 * zéro décimale.
 *
 * `address` et `openingHoursSpecification` s'y ajoutent depuis #343, **quand
 * l'API les sert**. Ils restent absents autrement, et c'est la même règle qu'au
 * premier jour : un `PostalAddress` inventé serait une donnée structurée fausse,
 * ce qui coûte plus cher en référencement qu'une donnée absente. La condition
 * n'est pas décorative — `publicTenantSchema` déclare les deux `.optional()`, et
 * un salon fraîchement inscrit n'a rien saisi.
 *
 * Ce qu'il ne porte **pas**, et c'est délibéré :
 *
 * - la durée des prestations — `schema.org/Service` n'a aucune propriété de
 *   durée, et la loger dans une propriété voisine produirait un graphe invalide.
 *   Elle reste dans le HTML, où elle est lisible.
 */

/** Valeur JSON, écrite sans `any` — le graphe n'est qu'une structure de données. */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

interface SalonStructuredDataProps {
  readonly tenant: PublicTenant;
  readonly services: readonly PublicService[];
  /** Adresse absolue et canonique de cette page. */
  readonly url: string;
  /** Adresse absolue du tunnel de réservation. */
  readonly reservationUrl: string;
}

/**
 * Décimales de la devise, lues d'`Intl` plutôt que codées en dur — deux pour
 * l'euro, zéro pour l'ariary ou le yen.
 *
 * La locale est `en-US` et non `fr-FR` : ce nombre n'est pas destiné à un
 * humain mais à un analyseur, et schema.org attend le point décimal.
 */
function fractionDigitsOf(currency: string): number {
  return (
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** « 3500 EUR » (entier, plus petite unité) → « 35.00 », comme schema.org l'attend. */
function priceInMajorUnits(price: Money): string {
  const digits = fractionDigitsOf(price.currency);

  return (price.amountMinor / 10 ** digits).toFixed(digits);
}

/**
 * L'adresse en `schema.org/PostalAddress` (#343).
 *
 * Les noms de propriétés sont ceux de schema.org et non ceux du contrat :
 * `streetAddress`, `addressLocality`, `addressCountry`. Le complément d'adresse
 * rejoint `streetAddress` sur une seconde ligne — schema.org n'a pas de
 * propriété pour lui, et le loger ailleurs produirait un graphe qu'aucun
 * analyseur ne saurait lire.
 *
 * `addressCountry` reçoit le code ISO 3166-1 alpha-2 tel quel : la
 * documentation de schema.org le recommande explicitement, et un nom de pays
 * traduit serait moins exploitable qu'un code.
 */
function toPostalAddressGraph(address: PostalAddress): JsonValue {
  return {
    '@type': 'PostalAddress',
    streetAddress:
      address.line2 === undefined ? address.line1 : `${address.line1}\n${address.line2}`,
    ...(address.postalCode === undefined ? {} : { postalCode: address.postalCode }),
    addressLocality: address.city,
    addressCountry: address.country,
  };
}

/**
 * Les horaires en `openingHoursSpecification` (#343).
 *
 * Une entrée par plage, chacune avec **un seul** `dayOfWeek` : schema.org
 * accepte un tableau de jours pour factoriser, mais cela obligerait à regrouper
 * les jours aux horaires identiques, et un regroupement raté produit un graphe
 * faux là où une entrée par plage ne peut qu'être verbeuse.
 *
 * `closes: "24:00"` est conservé tel quel. C'est une heure ISO 8601 valide — la
 * borne de fin d'une journée civile — et la seule façon exacte de dire « ferme à
 * minuit ». Lui substituer `23:59` retirerait une minute que le salon n'a pas
 * dit fermer, ce qui est précisément le genre d'approximation que ce module
 * refuse ailleurs.
 */
function toOpeningHoursGraph(entries: readonly OpeningHoursEntry[]): readonly JsonValue[] {
  return entries.map((entry) => ({
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: SCHEMA_ORG_WEEKDAYS[entry.weekday] ?? String(entry.weekday),
    opens: entry.opensAt,
    closes: entry.closesAt,
  }));
}

/** Le graphe schema.org de la page — exporté pour être vérifié en test. */
export function buildSalonGraph(
  tenant: PublicTenant,
  services: readonly PublicService[],
  url: string,
  reservationUrl: string,
): JsonValue {
  const sections = groupServicesByCategory(services);

  return {
    '@context': 'https://schema.org',
    '@type': 'HealthAndBeautyBusiness',
    '@id': `${url}#salon`,
    name: tenant.name,
    url,
    currenciesAccepted: tenant.defaultCurrency,
    ...(tenant.contactEmail === undefined ? {} : { email: tenant.contactEmail }),
    ...(tenant.contactPhone === undefined ? {} : { telephone: tenant.contactPhone }),
    ...(tenant.address === undefined ? {} : { address: toPostalAddressGraph(tenant.address) }),
    ...(tenant.openingHours === undefined || tenant.openingHours.length === 0
      ? {}
      : { openingHoursSpecification: toOpeningHoursGraph(tenant.openingHours) }),
    ...(sections.length === 0
      ? {}
      : {
          hasOfferCatalog: {
            '@type': 'OfferCatalog',
            name: `Prestations — ${tenant.name}`,
            itemListElement: sections.map((section) => ({
              '@type': 'OfferCatalog',
              name: section.title,
              itemListElement: section.services.map((service) => ({
                '@type': 'Offer',
                price: priceInMajorUnits(service.price),
                priceCurrency: service.price.currency,
                url: `${url}#${service.slug}`,
                itemOffered: {
                  '@type': 'Service',
                  name: service.name,
                  ...(service.description === null ? {} : { description: service.description }),
                  ...(service.category === null ? {} : { category: service.category.name }),
                },
              })),
            })),
          },
        }),
    potentialAction: {
      '@type': 'ReserveAction',
      target: { '@type': 'EntryPoint', urlTemplate: reservationUrl },
    },
  };
}

/**
 * Sérialisation sûre d'un graphe dans un `<script>`.
 *
 * `JSON.stringify` seul ne suffit pas : un nom de salon ou une description de
 * prestation contenant `</script>` fermerait la balise et ferait passer la
 * suite pour du balisage. Ces textes viennent de la saisie d'un salon, donc
 * d'une source non maîtrisée. Échapper `<` en séquence d'échappement Unicode est licite en JSON, reste
 * lisible par un analyseur, et rend la sortie inerte.
 */
export function serializeJsonLd(graph: JsonValue): string {
  return JSON.stringify(graph).replace(/</g, '\\u003c');
}

export function SalonStructuredData({
  tenant,
  services,
  url,
  reservationUrl,
}: SalonStructuredDataProps) {
  return (
    <script
      type="application/ld+json"
      // Le contenu d'un `<script>` n'est pas du texte React : il n'y a pas
      // d'autre moyen de l'écrire, et il est échappé juste au-dessus.
      dangerouslySetInnerHTML={{
        __html: serializeJsonLd(buildSalonGraph(tenant, services, url, reservationUrl)),
      }}
    />
  );
}
