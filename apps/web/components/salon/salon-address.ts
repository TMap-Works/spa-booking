import { addressLocalityLine, addressLocalityParts, type PostalAddress } from '@spa/shared';

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
 *
 * ## L'État s'écrit avec une virgule, et elle ne sépare pas ce qu'on croit (#1335)
 *
 * « New York, NY 10118 ». La virgule sépare la **ville de l'État**, jamais la
 * ville du code postal : l'USPS écrit « CITY ST ZIP », et un salon sans État
 * s'annonce « New York 10118 » sans virgule du tout. C'est pour cela que la
 * ponctuation ne pouvait pas être livrée par #1332, qui n'avait que l'ordre — il
 * fallait d'abord la colonne, et elle est arrivée avec ce ticket.
 *
 * ## La règle d'ordre a déménagé dans le contrat (#1334)
 *
 * Ce module la **consomme** désormais au lieu de la porter : elle vit dans
 * `packages/shared` (`addressLocalityLine`, `addressLocalityParts`). La raison
 * est qu'`apps/api` ne peut pas atteindre ce fichier, et que trois surfaces y
 * vivent qui écrivent la même enveloppe — le PDF du reçu et les e-mails de
 * confirmation, de rappel et d'annulation. Elles gardaient l'ordre français sur
 * un salon de Manhattan tant que la règle était ici.
 *
 * Ce qui reste ici est ce qui **dépend de l'écran** : le nom du pays traduit par
 * `Intl.DisplayNames`, la ligne d'identité du bandeau et le lien d'itinéraire.
 * Une règle de pays d'un côté, une règle de langue de l'autre — la frontière est
 * la même que celle que tout ce module tient depuis #846.
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
    // `addressLocalityLine` et non les morceaux recollés : c'est la même ligne
    // d'enveloppe que rend la fiche de la console, virgule d'État comprise
    // (#1335), et la recomposer ici l'aurait fait diverger au premier salon
    // américain — exactement la faute que #1330 a relevée sur l'ordre.
    addressLocalityLine(address),
    countryName(address.country, display),
  ];
}

/** Un morceau d'adresse est écrit s'il n'est ni absent, ni nul, ni vide. */
function isWritten(part: string | null | undefined): part is string {
  return part !== undefined && part !== null && part.trim() !== '';
}

/**
 * La ligne de localité d'une adresse — « 75011 Paris », « New York, NY 10118 ».
 *
 * Réexportée du contrat, et non réécrite ici (#1334) : `addressLocalityLine` est
 * le point d'écriture unique de cette ligne pour le front **et** pour le
 * serveur. La fiche d'un salon dans la console de l'éditeur, qui met la localité
 * et le pays sur une même ligne séparés d'un point médian, continue de l'importer
 * d'ici — c'est le module des adresses de salon du parcours public, et la lui
 * faire chercher dans `@spa/shared` n'aurait déplacé qu'un import.
 *
 * Ce que le déménagement a changé, en revanche : le ticket de caisse, le PDF du
 * reçu et les e-mails écrivent enfin la même ligne. Ils recomposaient la leur
 * faute de pouvoir atteindre ce fichier depuis `apps/api`.
 */
export { addressLocalityLine as localityLine } from '@spa/shared';

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
 *
 * L'État y entre comme un morceau parmi les autres — « New York, NY, 10118 »
 * (#1335) —, et non avec la ponctuation de l'enveloppe : ici tout est séparé par
 * des virgules, et c'est précisément ce qui désambiguïse Springfield.
 */
export function addressQuery(address: PostalAddress): string {
  return [address.line1, address.line2, ...addressLocalityParts(address), address.country]
    .filter(isWritten)
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
