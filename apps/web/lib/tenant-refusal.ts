import { ERROR_CODES, errorMessage, type Locale } from '@spa/shared';

/**
 * Le refus d'établissement inconnu, fabriqué **une fois** — #1395.
 *
 * ## L'arbitrage que ce module tranche
 *
 * Le fil #1372 → #1375 → #1379 → #1391 → #1394 a posé le code et sa phrase sur
 * toutes les surfaces d'`apps/web`, et laissé derrière lui **trois** fabricants du
 * même refus, identiques à la ligne près : celui du back-office
 * (`app/(admin)/[tenantSlug]/admin/action-result.ts`), celui de l'espace client
 * (`app/(account)/[tenantSlug]/compte/actions.ts`), celui du tunnel public
 * (`app/(booking)/[tenantSlug]/reservation/actions.ts`).
 *
 * La copie avait été acceptée chaque fois délibérément, et chaque fois écrite : les
 * surfaces ont leur **propre type de refus**, et celui du back-office porte un
 * `details` facultatif — le report du corps d'erreur de l'API (#1210) — qui n'a pas
 * de sens chez les deux autres, où rien ne lit ce corps. `action-result.ts` n'est
 * donc pas importable par elles, et ce qui se partagerait vraiment est le couple
 * `{ code, message }` : trois lignes.
 *
 * **C'est tout de même la mutualisation qui est retenue**, et voici sur quoi.
 *
 * - **L'obstacle n'était pas le partage, c'était sa direction.** Ce qui a fait
 *   renoncer trois fois est l'import d'une surface vers une autre — le `details` du
 *   back-office descendant chez qui n'en a pas l'usage. Un troisième domicile, plus
 *   étroit que les trois, ne charrie rien de personne : {@link UnknownTenantRefusal}
 *   n'a pas de `details`, et il reste assignable aux trois types de refus — chez le
 *   back-office parce que `details` y est facultatif, chez les deux autres parce
 *   qu'il est exactement leur forme. Rien ne se propage, et c'est ce que le
 *   deuxième critère du ticket exigeait. La règle est d'ailleurs écrite :
 *   *« ce qui est partagé vit dans `components/ui/` (design system) ou `lib/` »*
 *   (skill `web-frontend`), et c'est ici, aux côtés de `refusal.ts` qui tient déjà
 *   la règle de lecture d'un refus.
 * - **Une copie qui ne doit jamais diverger n'a aucun bénéfice de l'être.** Le
 *   quatrième critère du ticket demande que les suites de la classe restent vertes
 *   sans modification, c'est-à-dire que les trois rendent le **même** refus,
 *   aujourd'hui et demain. Garder trois copies sous cette contrainte aurait obligé à
 *   les garder par une mesure — un test qui relit les trois et les compare, comme
 *   #1397 en a posé un sur le registre faute de pouvoir compter autrement. Soit le
 *   même couplage, pour plus de code : l'indépendance qu'une copie achète n'est pas
 *   celle qu'on voulait.
 * - **La tendance tranche**, et c'est l'argument de #1319 sur `invalidFromZod`.
 *   Cinq tickets ont visité ce refus en quelques semaines, et chacun l'a réécrit là
 *   où il passait : #1372 au comptoir et au planning, #1375 sur l'espace client,
 *   #1391 sur le tunnel, #1394 sur les deux Route Handlers. Une surface de plus est
 *   plus probable qu'improbable, et elle n'a désormais qu'un import à faire.
 *
 * Ce qui n'a **pas** changé : le refus rendu. Même `TENANT_NOT_FOUND`, même phrase,
 * même langue, même absence de `details` — les fabricants des trois surfaces ne font
 * plus que déléguer ici, sous leur type et sous leur nom.
 *
 * ## Synchrone, et la langue en paramètre
 *
 * C'était la troisième question du ticket, et elle se tranche du même geste : deux
 * surfaces passaient la langue, le back-office la lisait lui-même.
 *
 * La forme partagée est la **synchrone**, pour une raison qui ne laisse pas le
 * choix : les deux autres fabricants vivent dans des modules `'use server'`, qui
 * n'exportent que des fonctions asynchrones — chacune devenant un point d'entrée
 * appelable depuis le navigateur — et leurs appelants ont déjà lu la langue de la
 * requête. L'asynchronie du back-office est donc ce qu'il **ajoute** à ce refus,
 * parce que ses appelants n'ont pas la langue sous la main, et non ce qu'il partage :
 * elle reste chez lui, dans une façade d'une ligne.
 *
 * Conséquence voulue : ce module n'importe pas `next-intl/server`. Il ne connaît que
 * le contrat partagé, reste importable des deux côtés de la frontière serveur comme
 * `refusal.ts`, et n'interroge jamais la requête — un chargement qui aboutit n'a pas
 * à payer une lecture de langue pour une phrase dont il n'a pas l'usage.
 *
 * ## Pourquoi ce nom, et non `unknownTenant`
 *
 * Les trois surfaces gardent le leur : `unknownTenant` nomme le refus qu'elles
 * opposent, et aucune n'est renommée — les modules d'actions du back-office
 * appellent la façade d'`action-result.ts`, hors du périmètre de ce ticket. Ce
 * module-ci nomme ce qu'il **fabrique**, et le nom distinct n'est pas une coquetterie :
 * `tests/unit/registre-etablissement-inconnu.test.ts` reconnaît un émetteur de la
 * classe à son appel de `unknownTenant`, et exclut la façade du back-office par son
 * chemin (#1397). Une fabrique qui porterait ce nom-là se compterait comme un
 * émetteur de plus et ferait mentir la notice de `WEB_ACTION_ERROR_CODES` — alors
 * qu'elle n'émet rien, elle est appelée. Le nom rend la distinction lisible sans
 * allonger une liste d'exceptions : ce qui s'appelle `unknownTenant` refuse, ce qui
 * s'appelle `…Refusal` fabrique.
 */

/**
 * Le refus d'établissement inconnu, dans sa forme la plus étroite — celle que les
 * trois surfaces ont en commun.
 *
 * Pas de `details`, et c'est l'invariant qui le veut : ce que `details` porte vient
 * de l'API et d'elle seule (`action-result.ts`, #1210), ce qui est ce qui rend son
 * report sûr au regard de `tenant-isolation` §4. Ce refus-ci n'atteint jamais l'API
 * — il constate que le segment d'URL n'a pas la forme d'une adresse de salon —, il
 * n'a donc rien à en reporter.
 *
 * Ce type n'est pas celui d'une surface et ne cherche pas à le devenir : chacune
 * garde le sien, et il s'y assigne.
 */
export interface UnknownTenantRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

/**
 * Le refus à opposer quand le slug de l'URL ne désigne aucun établissement.
 *
 * Le code est celui du contrat partagé, et la phrase celle de sa table bilingue —
 * jamais celle d'un catalogue d'écran : « Cet établissement est introuvable. » est
 * exactement ce qu'il y a à dire, et le contrat le dit dans les deux langues
 * (#1391). Elle n'est d'ailleurs presque jamais affichée telle quelle — les écrans
 * gardent le code et réécrivent la phrase à chaque rendu (`lib/refusal.ts`, #1327 et
 * #1354) —, mais elle reste ce que le contrat d'une action promet, et un appelant
 * qui n'aurait que le résultat doit y trouver une phrase déjà dans sa langue.
 */
export function unknownTenantRefusal(locale: Locale): UnknownTenantRefusal {
  return {
    ok: false,
    code: ERROR_CODES.TENANT_NOT_FOUND,
    message: errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale),
  };
}
