import type { PostalAddress } from '@spa/shared';

import { formattingLocale, type DisplayLocale } from '@/lib/format';

/**
 * L'adresse postale d'un salon, telle que le parcours public l'écrit (#343,
 * complété par #1046).
 *
 * Module à part, et non deux fonctions au fond d'un composant : le bandeau
 * d'identité, la carte « Nous trouver » et le pied du gabarit écrivent la même
 * adresse à trois endroits, et une ligne de ville composée trois fois finirait
 * par diverger sur le seul cas intéressant — un salon sans code postal.
 *
 * Aucun JSX ici : la présentation d'une adresse est de la logique pure, et elle
 * se teste comme telle.
 *
 * ## La langue (#846)
 *
 * Une adresse est du contenu de salon : la voie, le complément, le code postal
 * et la ville s'affichent tels quels, dans la langue où la gérante les a saisis.
 * **Un seul élément se traduit** — le nom du pays, qu'`Intl.DisplayNames` sait
 * écrire dans n'importe quelle langue à partir du code ISO du contrat.
 *
 * Le contexte d'affichage arrive donc en dernier paramètre, facultatif, comme
 * dans `lib/format.ts`, dont `formattingLocale` construit l'étiquette : la
 * région vient du pays de l'établissement, et un repli figé quand il est vide.
 * Le défaut français garde le comportement d'avant le ticket pour les cinq
 * appelants qui vivent hors de l'empreinte de #846 — le pied du gabarit, la
 * carte du salon de l'espace client, la fiche d'un rendez-vous, le cadre
 * d'accueil de la connexion et le récapitulatif du tunnel — et tombera avec le
 * dernier ticket d'écran de l'épique #843.
 */

/** Le contexte d'affichage employé quand l'appelant n'en passe pas encore. */
const FALLBACK_DISPLAY: DisplayLocale = { locale: 'fr' };

/**
 * L'adresse en lignes d'affichage.
 *
 * Ni virgules ni format national : une adresse postale se lit en lignes, et
 * c'est ce que rend une pile de `<span>`. Le code postal et la ville partagent
 * la leur, comme sur une enveloppe ; le pays reste à part.
 *
 * Le pays est rendu **en toutes lettres** quand l'environnement sait le
 * traduire, et en code sinon — « France » ou « Frankreich » selon qui lit
 * (#846). `Intl.DisplayNames` fait partie d'ECMA-402 et est disponible dans Node
 * comme dans tous les navigateurs visés ; le repli existe pour ne jamais rendre
 * une chaîne vide si un code inconnu passait.
 */
export function addressLines(
  address: PostalAddress,
  display: DisplayLocale = FALLBACK_DISPLAY,
): readonly string[] {
  const locality = [address.postalCode, address.city].filter((part) => part !== undefined);

  return [
    address.line1,
    ...(address.line2 === undefined ? [] : [address.line2]),
    locality.join(' '),
    countryName(address.country, display),
  ];
}

function countryName(code: string, display: DisplayLocale): string {
  try {
    return (
      new Intl.DisplayNames([formattingLocale(display.locale, display.countryCode)], {
        type: 'region',
      }).of(code) ?? code
    );
  } catch {
    return code;
  }
}

/**
 * Où est le salon, en une poignée de mots — la ligne du bandeau d'identité
 * (BM-VITRINE-01).
 *
 * La ville seule, pas l'adresse entière : le bandeau doit tenir sous le nom à
 * 360 px, et « 12 rue des Lilas, Bâtiment B, 75011 Paris, France » n'y tient
 * pas. C'est la carte « Nous trouver » qui porte l'adresse complète, et le lien
 * du bandeau y mène — comme il mène à l'itinéraire.
 *
 * `null` quand le salon n'a pas publié d'adresse : la ligne d'identité se borne
 * alors à ce qu'elle sait.
 */
export function addressLocality(address: PostalAddress | undefined): string | null {
  return address?.city ?? null;
}

/**
 * L'adresse en une seule ligne, prête à être passée à un service de cartes.
 *
 * Séparée par des virgules — c'est la forme qu'attend une requête
 * géographique —, là où `addressLines` rend la forme d'une enveloppe. Le pays
 * y va en code : c'est ce que le contrat porte, et un nom traduit rendrait la
 * requête dépendante de la locale du serveur.
 */
export function addressQuery(address: PostalAddress): string {
  return [address.line1, address.line2, address.postalCode, address.city, address.country]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(', ');
}

/**
 * L'itinéraire vers le salon (BM-VITRINE-07) — « l'adresse sert à venir, pas
 * seulement à être lue ».
 *
 * `google.com/maps/search/?api=1&query=…` plutôt qu'un schéma `geo:` ou
 * `maps://` : c'est le seul point d'entrée documenté qui fonctionne des deux
 * côtés — sur mobile, l'application de cartes intercepte l'URL et s'ouvre sur le
 * lieu ; sur ordinateur, la page web rend la carte. Un `geo:` avec des
 * coordonnées serait plus direct, mais le contrat ne porte ni latitude ni
 * longitude, et les inventer à partir du texte demanderait un géocodage que le
 * MVP n'a pas.
 *
 * Le nom du salon précède l'adresse dans la requête : deux salons à la même rue
 * ne se distinguent que par lui, et une recherche qui le porte tombe sur la
 * fiche du bon établissement plutôt que sur un numéro de voie.
 */
export function directionsUrl(name: string, address: PostalAddress): string {
  const query = encodeURIComponent(`${name}, ${addressQuery(address)}`);

  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
