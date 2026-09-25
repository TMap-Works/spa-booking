import type { OpeningHoursEntry, PostalAddress, PublicService, PublicTenant } from '@spa/shared';
import { useTranslations } from 'next-intl';

import { formatAmountMachine } from '@/lib/format';
import fr from '@/messages/fr/booking.json';

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
 * La conversion vient de `formatAmountMachine`, dans `lib/format.ts` (#344) :
 * c'est le seul module du front autorisé à convertir un montant, et il lit les
 * décimales de la devise là où `formatMoney` les lit. Une seconde lecture ici
 * aurait pu diverger de celle-là sur une devise à zéro décimale (ariary, yen),
 * et le prix affiché aurait alors cessé d'être celui du graphe. `formatMoney`
 * lui-même ne convient pas : sa sortie est localisée — virgule décimale,
 * symbole, espace insécable — et aucun analyseur ne l'accepte.
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
 *
 * ## La langue (#846)
 *
 * Presque rien n'est à traduire ici, et c'est le fond du sujet : un graphe
 * schema.org est fait de **données** et d'**identifiants**. Les `@type`, les
 * énumérations (`https://schema.org/Monday`), le code pays ISO, les heures
 * murales, la devise et les prix en forme machine ne changent pas d'une langue à
 * l'autre — les traduire rendrait le graphe illisible pour l'analyseur qui le
 * lit.
 *
 * Restent **deux noms de catalogue** que le graphe fabrique lui-même : celui de
 * l'`OfferCatalog` de tête — « Prestations — Maison Lotus » — et le titre de la
 * rubrique fictive des prestations non classées. Ceux-là s'affichent dans un
 * résultat de recherche, et ils suivent donc la langue de la page.
 *
 * `buildSalonGraph` reste une fonction **pure**, exportée pour être vérifiée
 * comme un objet : elle reçoit ces deux mots en dernier paramètre, facultatif,
 * plutôt que de lire un crochet qu'un test sans DOM ne saurait fournir. Le
 * composant, lui, les prend au catalogue.
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

/**
 * Les deux seuls mots que le graphe fabrique, et qu'un humain lira (#846).
 *
 * Ni les `@type`, ni les énumérations, ni les noms saisis par le salon : voir le
 * bloc de tête.
 */
export interface SalonGraphLabels {
  /** Le nom de l'`OfferCatalog` de tête — « Prestations — {nom du salon} ». */
  readonly catalogName: string;
  /** Le titre de la rubrique qui recueille les prestations non classées. */
  readonly unclassified: string;
}

/**
 * Les deux mots en français, pour un appelant qui ne résout pas encore la
 * langue — les suites de tests, aujourd'hui.
 *
 * Lus dans le catalogue et non réécrits : c'est ce qui garantit que le graphe et
 * la page annoncent le même nom de rubrique.
 *
 * L'import du catalogue reste ici, et nulle part en amont (#1142) : ce fichier
 * est un **Server Component** — la liste fermée des îlots clients de
 * `components/salon/` est vérifiée par `tests/unit/salon-structured-data.test.tsx`
 * —, webpack n'en suit donc l'import pour aucun bundle de navigateur. C'est
 * précisément ce qui n'était pas vrai de `group-services.ts`, où ce même repli
 * vivait : atteignable depuis l'étape « prestation » du tunnel, il y embarquait
 * `booking.json` entier.
 */
function fallbackLabels(tenantName: string): SalonGraphLabels {
  return {
    catalogName: fr.salon.structuredData.catalogName.replace('{name}', tenantName),
    unclassified: fr.salon.catalog.unclassified,
  };
}

/** Le graphe schema.org de la page — exporté pour être vérifié en test. */
export function buildSalonGraph(
  tenant: PublicTenant,
  services: readonly PublicService[],
  url: string,
  reservationUrl: string,
  labels: SalonGraphLabels = fallbackLabels(tenant.name),
): JsonValue {
  const sections = groupServicesByCategory(services, labels.unclassified);

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
            name: labels.catalogName,
            itemListElement: sections.map((section) => ({
              '@type': 'OfferCatalog',
              name: section.title,
              itemListElement: section.services.map((service) => ({
                '@type': 'Offer',
                price: formatAmountMachine(service.price),
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
    // La `ReserveAction` suit exactement la même condition que le catalogue
    // (#773) : un salon sans prestation publiée n'a pas de réservation à
    // annoncer, et son tunnel refuse de démarrer. La déclarer quand même
    // publierait à un moteur de recherche le point d'entrée d'un cul-de-sac —
    // la version lisible par machine du bouton que l'en-tête vient de retirer.
    // Même règle que l'adresse et les horaires juste au-dessus : une donnée
    // structurée fausse coûte plus cher en référencement qu'une donnée absente.
    ...(sections.length === 0
      ? {}
      : {
          potentialAction: {
            '@type': 'ReserveAction',
            target: { '@type': 'EntryPoint', urlTemplate: reservationUrl },
          },
        }),
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
  const t = useTranslations('booking');
  const labels: SalonGraphLabels = {
    catalogName: t('salon.structuredData.catalogName', { name: tenant.name }),
    unclassified: t('salon.catalog.unclassified'),
  };

  return (
    <script
      type="application/ld+json"
      // Le contenu d'un `<script>` n'est pas du texte React : il n'y a pas
      // d'autre moyen de l'écrire, et il est échappé juste au-dessus.
      dangerouslySetInnerHTML={{
        __html: serializeJsonLd(buildSalonGraph(tenant, services, url, reservationUrl, labels)),
      }}
    />
  );
}
