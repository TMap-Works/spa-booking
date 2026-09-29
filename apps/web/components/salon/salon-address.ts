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
 * Le contexte d'affichage arrive donc en dernier paramètre, comme dans
 * `lib/format.ts`, dont `formattingLocale` construit l'étiquette : la région
 * vient du pays de l'établissement, et un repli figé quand il est vide.
 *
 * ## Le paramètre est obligatoire (#1297)
 *
 * Il était facultatif, avec un défaut français, le temps que les cinq appelants
 * hors de l'empreinte de #846 se branchent — le pied du gabarit, la carte du
 * salon de l'espace client, la fiche d'un rendez-vous, le cadre d'accueil de la
 * connexion et le récapitulatif du tunnel. Aucun ne l'a fait, et un visiteur
 * anglais lisait « États-Unis » dans le pied de **toutes** les pages publiques.
 * Remplacer le défaut par `DEFAULT_LOCALE` aurait rendu la faute inverse — un
 * écran français annonçant « United States » — aussi silencieuse. Le paramètre
 * est donc exigé par le type : `tsc` nomme l'appelant qui l'oublie.
 *
 * ## L'ordre suit le pays du salon, non la langue du lecteur (#1330)
 *
 * Une adresse nord-américaine écrit « New York 10118 », une adresse française
 * « 75011 Paris ». C'est la seule chose que le pays change à la mise en page, et
 * c'est la faute que la recette de traduction a relevée : un salon de Manhattan
 * s'annonçait « 10118 New York » sur sa vitrine, dans son `.ics` et dans la fiche
 * de la console.
 *
 * Le critère est le **pays de l'établissement**, jamais la langue de l'écran :
 * l'adresse d'un salon parisien lu en anglais reste « 75011 Paris », parce que
 * c'est ce qu'on écrit sur l'enveloppe qu'on lui poste. Confondre les deux aurait
 * réordonné l'adresse d'un salon selon qui la regarde — c'est le même arbitrage
 * que le reste de ce module, où seul le nom du pays se traduit.
 */

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
  display: DisplayLocale,
): readonly string[] {
  return [
    address.line1,
    ...(address.line2 === undefined ? [] : [address.line2]),
    localityParts(address).join(' '),
    countryName(address.country, display),
  ];
}

/**
 * Les pays qui écrivent la **ville avant le code postal** — #1330.
 *
 * Les deux du périmètre nord-américain, et eux seuls. Ce n'est volontairement pas
 * une table des conventions postales du monde : le produit ouvre onze pays
 * (`lib/salon-presets.ts`), dix d'entre eux écrivent le code postal en tête, et
 * une table exhaustive serait une donnée de référence à maintenir pour deux
 * lignes de sortie. Un pays qu'on ajouterait ici se voit sur une ligne de diff ;
 * une table de deux cents entrées se relit une fois et se croit ensuite.
 */
const CITY_BEFORE_POSTAL_CODE: ReadonlySet<string> = new Set(['US', 'CA']);

/**
 * La localité, ses morceaux dans l'ordre du pays — « 75011 », « Paris » d'un
 * côté, « New York », « 10118 » de l'autre.
 *
 * Rendue en morceaux et non déjà jointe : `addressLines` les colle à l'espace,
 * comme sur une enveloppe, et `addressQuery` les sépare par des virgules, comme
 * une requête géographique. Un seul ordre, deux ponctuations — plutôt que deux
 * fonctions qui décideraient chacune de l'ordre et finiraient par ne plus le
 * décider pareil.
 *
 * Le code postal est **omis** quand il manque : tous les pays n'en ont pas
 * (`postalAddressSchema`), et une localité ne doit jamais commencer ni finir par
 * une espace en trop.
 */
function localityParts(address: LocalityAddress): readonly string[] {
  const ordered = CITY_BEFORE_POSTAL_CODE.has(address.country)
    ? [address.city, address.postalCode]
    : [address.postalCode, address.city];

  return ordered.filter(
    (part): part is string => part !== undefined && part !== null && part !== '',
  );
}

/**
 * Ce qu'il faut savoir d'une adresse pour en ordonner la localité.
 *
 * Trois champs et non `PostalAddress` : la fiche de la console reçoit son adresse
 * d'un autre schéma du contrat (`platformTenantDetailSchema`), qui rend `null` là
 * où la vitrine omet la clé. Décrire le minimum requis accepte les deux formes
 * sans qu'aucun appelant ait à recomposer un objet pour satisfaire un type — et
 * sans que ce module ait à connaître la différence.
 *
 * `| undefined` est écrit explicitement en plus du `?` : sous
 * `exactOptionalPropertyTypes`, une propriété facultative n'accepte pas `undefined`
 * comme **valeur**, et `PostalAddress.postalCode` en porte un.
 */
interface LocalityAddress {
  readonly postalCode?: string | null | undefined;
  readonly city: string;
  readonly country: string;
}

/**
 * La ligne de localité d'une adresse — « 75011 Paris », « New York 10118 ».
 *
 * Le point d'entrée des écrans qui affichent l'adresse **autrement** qu'en pile
 * de lignes. Un seul s'en sert à ce jour : la fiche d'un salon dans la console de
 * l'éditeur, qui met la localité et le pays sur une même ligne séparés d'un point
 * médian. Elle recomposait `[postalCode, city].join(' ')` de son côté (#1330), et
 * c'est ce doublon qui lui a fait garder l'ordre français sur un salon américain
 * alors que la vitrine du même salon était déjà correcte.
 *
 * ## Trois surfaces recomposent encore la localité de leur côté
 *
 * Le ticket de caisse (`lib/admin/receipt-ticket.ts`), le PDF du reçu
 * (`apps/api/.../receipt-pdf/receipt-pdf.template.ts`) et les e-mails de
 * confirmation et de rappel (`apps/api/.../notifications.repository.ts`) écrivent
 * encore « 10118 New York » pour un salon nord-américain. Elles sont hors de
 * l'empreinte de #1330 et laissées en suivi : les deux dernières vivent dans
 * `apps/api`, d'où ce module est inatteignable — les y brancher demande de monter
 * la règle dans `packages/shared`, ce qui est un changement de contrat et non une
 * reprise d'affichage.
 *
 * Il n'y a **pas** d'État/Province dans cette ligne, et c'est une limite connue,
 * non un oubli : le contrat ne porte pas ce champ (`postalAddressSchema`), donc
 * aucune colonne ne le stocke. « New York 10118 » est ce qu'on peut écrire de plus
 * juste avec ce qu'on a ; « New York, NY 10118 » — la virgule comprise, qui sépare
 * la ville de l'État et non la ville du code postal — demande d'abord la colonne.
 */
export function localityLine(address: LocalityAddress): string {
  return localityParts(address).join(' ');
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
 *
 * L'ordre de la localité est celui du pays, comme dans `addressLines` (#1330) :
 * un géocodeur tolère les deux, mais « New York, 10118 » lève une ambiguïté que
 * « 10118, New York » entretient — un code postal en tête se lit aussi comme un
 * numéro de voie. Et surtout, deux ordres pour la même adresse dans le même
 * module finissent par ne plus être deux choix mais un bug.
 */
export function addressQuery(address: PostalAddress): string {
  return [address.line1, address.line2, ...localityParts(address), address.country]
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
