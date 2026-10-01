/**
 * Ce que rend une action serveur du back-office, et rien d'autre.
 *
 * ## Pourquoi ce module existe à côté de `actions.ts`
 *
 * `actions.ts` porte la directive `'use server'`, et un module ainsi marqué ne
 * peut exporter que des fonctions asynchrones : Next transforme chacun de ses
 * exports en point d'entrée appelable depuis le navigateur. Un type, une
 * constante ou une fonction synchrone n'y ont pas leur place — d'où ce fichier
 * ordinaire, importable des deux côtés de la frontière.
 *
 * ## Le contrat
 *
 * Une action rend **toujours** un résultat, jamais une exception : un rejet
 * traverserait la frontière serveur en perdant son type, et le composant
 * client n'aurait plus qu'un message générique à afficher. Le refus porte donc
 * un `code` — c'est lui que les écrans lisent — et un `message`, destiné à un
 * humain (web-frontend §2).
 *
 * ## Et `details`, depuis #1210
 *
 * Un même `code` couvre parfois plusieurs refus, que l'API distingue dans son
 * corps d'erreur : `INVALID_STATE_TRANSITION` vaut aussi bien pour un
 * rendez-vous déjà soldé que pour un rendez-vous qui n'a pas commencé, et seul
 * `details.notStarted` les sépare (#1137). Sans ce report, l'écran n'avait que
 * le message de l'API à réémettre, et ne pouvait pas conduire l'opérateur vers
 * le geste qui débloque — attendre l'heure du rendez-vous.
 *
 * Ce que `details` porte vient de l'API et d'elle seule, et le contrat d'erreur
 * lui interdit déjà toute donnée d'établissement ou de cliente
 * (tenant-isolation §4) : le traverser jusqu'à l'écran n'ouvre donc aucune
 * fuite que le corps d'erreur n'ouvrait pas.
 *
 * ## Et `message` se dit dans la langue de la session — #1234
 *
 * Il venait du corps d'erreur de l'API, c'est-à-dire **en français** : l'API n'a
 * pas de langue de requête, ses `DomainError` sont écrites une fois pour le
 * journal et pour le diagnostic. Une quinzaine d'écrans du back-office affichent
 * ce `message` tel quel — `staff-profile-panel.tsx`, `service-form.tsx`,
 * `client-picker.tsx`… — et redevenaient donc bilingues au premier refus.
 *
 * La phrase vient désormais de `errorMessage(code, locale)` du contrat partagé,
 * comme l'espace client le fait depuis #847 : une table bilingue adossée à
 * `ERROR_CODES`, où un code inconnu — les `HTTP_<statut>` que le filtre
 * d'exception de l'API fabrique — retombe sur la phrase générique
 * d'`INTERNAL_ERROR`. C'est ce qui rend vrai *« aucun écran ne retombe sur un
 * message brut de l'API »* en **un seul point** plutôt qu'en quinze.
 *
 * Le prix est assumé : un refus que l'API détaillait dans son message se dit
 * maintenant par la phrase de son code. Ce qui distinguait deux refus d'un même
 * code n'a jamais tenu dans cette phrase — c'est `details` qui le porte (#1210),
 * et c'est lui que l'écran lit pour conduire vers le geste qui débloque.
 *
 * D'où des fonctions **asynchrones** : la langue se lit sur la requête. Leurs
 * appelants sont tous des actions serveur qui font `return failure(error)` — une
 * fonction `async` déballe la promesse qu'on lui rend, et aucun d'eux n'a changé.
 *
 * ## Ce module connaît zod, et c'est une décision — #1319
 *
 * #1310 a ramené ici la **phrase** du repli de validation
 * (`validationRefusal`), mais pas la **forme d'appel** qui l'emploie le plus
 * souvent, restée recopiée mot pour mot à cinq endroits :
 *
 * ```ts
 * invalid(parsed.error.issues[0]?.message ?? validationRefusal(locale))
 * ```
 *
 * Deux voies s'offraient : la replier derrière un export de ce module, au prix
 * d'un type de zod dans sa signature, ou la laisser telle quelle au motif que
 * trois jetons répétés coûtent moins qu'une indirection de plus. **C'est la
 * première qui est retenue**, et voici sur quoi :
 *
 * - **la règle repliée est une règle de ce module.** « Le message du premier
 *   refus quand le schéma en nomme un — c'est ce qui distingue « douze
 *   caractères au minimum » d'un mot de passe absent — et à défaut la phrase du
 *   code » énonce *ce que dit un refus*. C'est l'objet même de ce fichier, qui
 *   tient déjà le code (`invalid`) et le repli (`validationRefusal`) sans tenir
 *   leur assemblage ;
 * - **le prix redouté n'est pas celui qu'on croyait.** La dépendance envers zod
 *   est un `import type` : elle est effacée à la compilation, n'ajoute aucun
 *   octet au bundle et aucun couplage d'exécution. `apps/web` déclare déjà zod
 *   en dépendance directe et type-importe déjà `ZodIssue` dans deux formulaires
 *   du personnel. Ce module reste ce qu'il est — des formes, importables des
 *   deux côtés de la frontière serveur ;
 * - **la tendance tranche.** #1234 a changé d'où venait cette phrase, #1299 la
 *   langue dans laquelle elle se dit, #1310 son repli : trois tickets qui ont dû
 *   visiter chaque copie. Un quatrième est plus probable qu'improbable, et ce
 *   sont cinq visites à chaque fois.
 *
 * Ce qui n'a **pas** changé : le refus rendu. Même `VALIDATION_ERROR`, même
 * phrase, même langue — `invalidFromZod` n'est que l'assemblage d'`invalid()` et
 * du `??`, à la lettre.
 *
 * ## L'établissement inconnu a son code, et non un marqueur — #1372
 *
 * C'est la décision de ce ticket, et elle se dit ici parce que c'est ici que le
 * refus se fabrique ({@link unknownTenant}) ; son autre moitié — le code et sa
 * phrase bilingue — est écrite dans `WEB_ACTION_ERROR_CODES`
 * (`packages/shared/src/errors/error-codes.ts`).
 *
 * Le refus d'établissement inconnu portait `VALIDATION_ERROR`, sans `details`,
 * comme les refus de saisie que chaque geste oppose. Or c'est exactement par
 * l'absence de `details` que les quatre écrans du planning et du comptoir
 * reconnaissaient « le refus que l'action a opposé elle-même », pour lui prêter
 * la phrase du geste (#1367, #1369). La garde est juste pour ce qu'elle a été
 * écrite — séparer l'action de l'API —, mais deux refus que la **même** action
 * oppose d'elle-même y sont indiscernables : « Établissement inconnu » se disait
 * donc « Recherche invalide. », « Le report saisi est invalide. », « Date de
 * planning invalide. ».
 *
 * Deux voies étaient ouvertes. **Un marqueur dans `details`** aurait obligé
 * `invalid()` à en poser un, c'est-à-dire à faire précisément ce que
 * `details === undefined` sert à exclure : le refus se serait mis à passer pour
 * un refus de l'API sur les quatre écrans, à moins de lire le marqueur *avant* la
 * garde — un ordre que rien n'imposerait au cinquième écran. Et il aurait
 * contredit ce que la section « Et `details`, depuis #1210 » énonce plus haut :
 * ce que `details` porte vient de l'API et d'elle seule, ce qui est ce qui rend
 * son report sûr au regard de `tenant-isolation` §4.
 *
 * **Le code propre** ne demande rien de tout cela. Les écrans trient déjà sur le
 * code et réservent la phrase de leur geste au seul `VALIDATION_ERROR` : un code
 * distinct les corrige tous les quatre sans toucher à leur logique, et leur repli
 * — `errorMessage(code, locale)`, déjà en place depuis #1234 — rend la phrase qui
 * nomme l'établissement, dans la langue du rendu.
 *
 * Ce que `details` dit n'a donc pas changé d'un mot, et c'est voulu : ce ticket
 * ajoute un code, il ne redéfinit pas la garde des quatre écrans.
 *
 * ## …et cinq autres modules d'actions le portent — #1375
 *
 * #1372 n'avait appliqué le remède qu'au planning et au comptoir, faute de quoi
 * son ticket aurait débordé. Cinq autres modules d'actions jugeaient le même
 * slug de la même façon et rendaient encore `invalid(t('…unknownTenant'))` :
 * `catalogue`, `clients`, `personnel`, `reporting`, et l'espace client. Ils
 * portent tous `TENANT_NOT_FOUND` désormais, par {@link unknownTenant} pour les
 * quatre premiers, par un jumeau local pour l'espace client — qui a son propre
 * fabricant de refus (`app/(account)/[tenantSlug]/compte/actions.ts`), pour la
 * raison écrite en tête de ce module-là.
 *
 * Le symptôme n'y était pas celui du comptoir, et c'est ce qui l'avait laissé
 * passer. Ces écrans-là ne prêtent la phrase d'aucun geste : ils gardent le code
 * et réécrivent la phrase au rendu (`lib/refusal.ts`, #1327 et #1354), si bien
 * qu'un `VALIDATION_ERROR` leur rendait la tournure générique du refus de
 * saisie — « Certaines informations sont incomplètes ou mal formées. » pour un
 * segment d'URL que personne n'avait tapé. Même cause, même remède, autre
 * symptôme.
 *
 * Aucun des dix-neuf écrans concernés n'a changé d'une ligne, et c'est le
 * résultat qui compte : le repli d'`refusalMessage` est `errorMessage(code,
 * locale)`, et il nomme l'établissement dès lors que le code le nomme.
 *
 * ## …et les deux derniers ferment la classe des surfaces authentifiées — #1379
 *
 * `admin/actions.ts` (connexion, déconnexion, réglages de l'établissement,
 * pages hébergées de l'abonnement) et `reglages/actions.ts` (langue du compte
 * connecté) jugeaient encore le slug sous `invalid(validationRefusal(…))`. Le
 * symptôme y était moindre — ils ne calculaient aucune phrase d'établissement à
 * perdre en chemin, ils posaient déjà celle du contrat pour `VALIDATION_ERROR` —,
 * mais l'écart était le même : « Certaines informations sont incomplètes ou mal
 * formées. » pour un segment d'URL que personne n'a tapé. Leurs six sites portent
 * `TENANT_NOT_FOUND` désormais, et **plus aucun module d'actions d'une surface
 * authentifiée — back-office ou espace client — ne refuse l'établissement inconnu
 * sous le code du refus de saisie**.
 *
 * Ce qui restait en dehors, et que #1391 a refermé depuis : le tunnel public de
 * réservation (`app/(booking)/[tenantSlug]/reservation/actions.ts`,
 * `loadAvailabilityAction`), qui jugeait le slug du même `if` que sa charge utile
 * et rendait `VALIDATION_ERROR`. Voir la section suivante — sa reprise était un
 * autre geste que celui-ci, et non une rallonge de ce diff.
 *
 * Trois choses s'y sont décidées, et elles se disent ici parce qu'elles valent
 * pour tout appelant de {@link unknownTenant} :
 *
 * - **le slug se juge seul, et en premier.** Quatre de ces six sites le jugeaient
 *   du même `if` que leur charge utile : le refus rendu dépendait de l'ordre des
 *   tests d'un `||`. L'ordre est désormais partout le même, et il est celui-ci
 *   parce qu'un slug qui ne désigne aucun établissement rend la saisie sans
 *   objet — reprocher un champ sur une adresse qui ne mène nulle part envoie
 *   chercher une faute qu'on n'a pas commise ;
 * - **`adminAcceptInvitationAction` est reprise**, et non laissée sous
 *   `invalidFromZod`. C'était le cas que #1319 avait mis à part, parce qu'il
 *   fallait trancher ce qui l'emporte quand le slug et la charge utile refusent
 *   ensemble. C'est l'établissement, pour la raison ci-dessus ; la saisie ne perd
 *   rien, jugée juste après et nommant toujours son champ fautif. Conséquence
 *   directe : plus aucun appelant d'`invalidFromZod` n'a de `ZodError` absente à
 *   lui passer, et sa signature ne la tolère plus — voir {@link invalidFromZod} ;
 * - **le chemin de renouvellement de session ne s'y trompe pas**, et cela a été
 *   vérifié plutôt que supposé. `isSessionExpired` de `lib/session-renewal.ts`
 *   compare le code à `UNAUTHORIZED` **et à lui seul** : un code nouveau ne peut
 *   donc pas faire prendre un refus d'établissement pour un refus de session.
 *   L'inverse ne peut pas non plus arriver, et c'est l'ordre des gardes qui
 *   l'assure : chacun de ces six sites juge le slug **avant** d'ouvrir la session
 *   (`adminActionAccess`), si bien qu'un `UNAUTHORIZED` ne peut sortir que d'un
 *   slug déjà jugé lisible.
 *
 * Les deux écrans de session sont vérifiés un par un, puisque c'est ce que le
 * ticket demandait : l'écran de connexion n'appelle pas `useAdminSessionRenewal`
 * du tout — il *est* le bout de ce chemin, et son encart nomme le refus par le
 * repli de sa table de codes (`admin-login-form.tsx`) ; le bouton de déconnexion
 * ne lit pas le résultat de son action et part vers la connexion quoi qu'il
 * arrive (`admin-logout-button.tsx`), ce qui est le comportement d'avant ce
 * ticket comme d'après — il n'affiche aucune phrase, ni l'ancienne ni la
 * nouvelle. Des trois autres écrans, deux passent par `renewIfExpired(result)` —
 * les réglages de l'établissement et la langue du compte —, qui rend `false` sur
 * `TENANT_NOT_FOUND` et leur laisse écrire la phrase ; le panneau d'abonnement,
 * lui, n'appelle pas le crochet et range `UNAUTHORIZED` dans sa propre table de
 * codes, ce que ce ticket ne touche pas. L'écran d'invitation, enfin, ne renouvelle
 * rien non plus : la session n'y est pas encore ouverte.
 *
 * ## …et le tunnel public ferme la classe pour de bon — #1391
 *
 * La clôture annoncée par #1379 était bornée aux **surfaces authentifiées**, et
 * nommait le tunnel public de réservation comme l'exception qui restait. Elle ne
 * l'est plus : `loadAvailabilityAction` juge le slug seul et en premier, et rend
 * `TENANT_NOT_FOUND`. **Plus aucun module d'actions serveur d'`apps/web` — publique
 * ou authentifiée — ne refuse l'établissement inconnu sous le code du refus de
 * saisie.** La liste des émetteurs de `WEB_ACTION_ERROR_CODES.TENANT_NOT_FOUND` est
 * close, et c'est là qu'elle se lit.
 *
 * « Module d'actions serveur » est à prendre au mot, et la réserve est écrite au
 * même endroit que la liste : deux **Route Handlers** de l'espace client jugent
 * encore ce slug sous `VALIDATION_ERROR` — la réservation et l'annulation, que
 * #1201 et #1207 ont converties en routes pour joindre le jeton de la cliente. Le
 * défaut les a suivies hors de la classe que ce fil referme, et leur reprise est un
 * autre geste. Ne pas lire la phrase en gras ci-dessus comme un compte rond.
 *
 * Ce module-ci n'y est pour rien d'autre que son en-tête, et c'est voulu : le tunnel
 * ne l'emploie pas. Il a son propre fabricant de refus — son `ActionResult` n'a pas
 * de `details`, rien n'y lisant celui du corps d'erreur de l'API — et porte donc un
 * jumeau local d'`unknownTenant`, comme l'espace client depuis #1375. Ce qui se dit
 * ici est ce qui vaut pour les trois : **un code du contrat, et sa phrase lue dans
 * la table bilingue.**
 *
 * Ce que #1391 a eu à trancher en plus des huit autres, parce que sa surface n'est
 * pas la leur : **d'où vient la phrase d'un refus quand le module n'emploie ni ce
 * fichier ni `refusalMessage`, et écrit la sienne depuis son catalogue.** La règle
 * retenue est celle que `lib/refusal.ts` encode déjà — le contrat par défaut, le
 * catalogue de la surface là où elle dit mieux que lui. D'où un partage, et non une
 * substitution : `TENANT_NOT_FOUND` passe au contrat, tandis que le refus de la
 * requête de créneaux garde `VALIDATION_ERROR` **et** sa phrase de catalogue, le
 * contrat ne sachant pas dire de quelle demande il s'agissait. L'argumentaire
 * complet, surface publique comprise, est en tête de
 * `app/(booking)/[tenantSlug]/reservation/actions.ts`.
 */

import { ERROR_CODES, errorMessage, type Locale } from '@spa/shared';
import { getLocale } from 'next-intl/server';
import type { ZodError } from 'zod';

import { ApiClientError } from '@/lib/api-client';

/**
 * Un refus, tel que les écrans le reçoivent.
 *
 * `details` est **facultatif** à dessein : la grande majorité des refus n'en ont
 * pas besoin — ils se lisent sur le `code` —, et l'exiger aurait obligé chaque
 * action du back-office à poser un objet vide pour satisfaire le type, sans rien
 * ajouter à ce qu'elle dit. Il est posé là où il porte quelque chose : les refus
 * qui remontent de l'API.
 */
export type AdminActionFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
};

export type AdminActionResult<TData> =
  | { readonly ok: true; readonly data: TData }
  | AdminActionFailure;

/**
 * Traduit une erreur remontée de l'API — ou n'importe quelle autre — en refus.
 *
 * Ce qui n'est pas une `ApiClientError` n'a pas de code : une panne du rendu,
 * une action serveur qui lève. `INTERNAL_ERROR` est ce que l'écran doit en
 * comprendre, et sa phrase générique est ce qu'il affiche.
 */
export async function failure(error: unknown): Promise<AdminActionFailure> {
  const code = error instanceof ApiClientError ? error.code : ERROR_CODES.INTERNAL_ERROR;
  const message = errorMessage(code, await getLocale());

  if (error instanceof ApiClientError) {
    return { ok: false, code, message, details: error.details };
  }

  return { ok: false, code, message };
}

/** Refus de validation : l'appel n'a même pas atteint l'API. */
export function invalid(message: string): AdminActionFailure {
  return { ok: false, code: ERROR_CODES.VALIDATION_ERROR, message };
}

/**
 * Refus faute d'établissement : le slug de l'URL n'en désigne aucun — #1372.
 *
 * Il se distingue du refus de saisie du geste par son **code**, et non par un
 * marqueur dans `details` : la raison du choix est en tête de ce module. Les
 * écrans n'ont donc rien à reconnaître de particulier — ils trient déjà sur le
 * code, et celui-ci n'est pas `VALIDATION_ERROR`, donc aucun d'eux ne lui prête
 * la phrase de son geste.
 *
 * Asynchrone pour la même raison que {@link failure} et {@link expired} : la
 * phrase vient d'`errorMessage`, qui a besoin de la langue de la requête. Elle
 * n'est d'ailleurs presque jamais affichée telle quelle — les écrans gardent le
 * code et réécrivent la phrase à chaque rendu (#1354) —, mais elle reste ce que
 * le contrat d'une action promet, et un appelant qui n'aurait que le résultat
 * doit y trouver une phrase déjà dans sa langue.
 */
export async function unknownTenant(): Promise<AdminActionFailure> {
  return {
    ok: false,
    code: ERROR_CODES.TENANT_NOT_FOUND,
    message: errorMessage(ERROR_CODES.TENANT_NOT_FOUND, await getLocale()),
  };
}

/**
 * La phrase générique d'un refus de validation, dans la langue donnée — #1310.
 *
 * C'est le repli de tout `safeParse` en échec des actions serveur : celles du
 * back-office, celles de la console de l'éditeur, celle de l'inscription. Elle
 * était recopiée mot pour mot à chacun de ses sites d'appel, alors que sa place
 * est ici — aux côtés d'`invalid()`, qui pose le code que cette phrase dit.
 *
 * Toujours `VALIDATION_ERROR`, et jamais un code choisi pour la phrase qu'il
 * porte : c'est le code qu'`invalid()` pose, et un refus dont la phrase dirait
 * autre chose que son code serait illisible pour l'écran, qui trie sur le code.
 *
 * ## Pourquoi synchrone, et pourquoi la langue en paramètre
 *
 * Synchrone parce qu'un module `'use server'` ne peut pas la porter : il
 * n'exporte que des fonctions asynchrones, dont chacune devient un point
 * d'entrée appelable depuis le navigateur — c'est la raison d'être de ce
 * fichier-ci, dite en tête de module. Elle rejoint donc `invalid()` du même
 * côté de la frontière, et non `failure()` ni `expired()`, qui lisent la langue
 * eux-mêmes parce que leurs appelants ne l'ont pas.
 *
 * La langue en paramètre, enfin, pour qu'une action qui la lit déjà — parce
 * qu'elle en fait aussi une carte de zod (#1299) — n'interroge pas la requête
 * deux fois. Celles qui n'en ont pas besoin par ailleurs passent
 * `await getLocale()` sur place.
 */
export function validationRefusal(locale: Locale): string {
  return errorMessage(ERROR_CODES.VALIDATION_ERROR, locale);
}

/**
 * Le refus d'un `safeParse` en échec — la forme d'appel, et non plus seulement sa
 * phrase de repli (#1319, voir l'en-tête de ce module).
 *
 * Elle dit une chose : **le message du premier refus quand le schéma en nomme
 * un**, parce que c'est ce qui distingue « douze caractères au minimum » d'un mot
 * de passe absent — et, à défaut, la phrase générique du code. Rien d'autre ne
 * change : le code est celui qu'`invalid()` pose, la langue celle du paramètre.
 *
 * Le `??` — et non un `||` — est le comportement d'origine, conservé à la
 * lettre : un message vide rendu par un schéma reste ce que l'action rend, et ce
 * n'est pas à ce module d'en décider autrement.
 *
 * ## L'erreur ne peut plus être absente — #1379
 *
 * Elle l'a pu, et pour un seul site : `adminAcceptInvitationAction` jugeait le
 * slug de l'URL et la charge utile d'un même `if`, si bien qu'un slug illisible
 * refusait sans qu'aucune `ZodError` n'existe. `undefined` n'était donc pas une
 * commodité d'appel, il servait ce site-là — et ce site a été repris : le slug s'y
 * juge seul et rend {@link unknownTenant}, pour la raison écrite en tête de ce
 * module. Plus aucun appelant n'a d'erreur absente à passer, et la signature ne la
 * tolère plus : la garder aurait laissé un paramètre facultatif dont la
 * justification venait d'être retirée, c'est-à-dire un commentaire faux à échéance.
 *
 * Le repli, lui, **reste** : `issues` peut être vide — une `ZodError` construite
 * sans issue, une carte d'erreurs qui n'en rend aucune —, et c'est alors la phrase
 * générique du code qui se dit, exactement comme sur une erreur absente.
 *
 * La langue reste un paramètre, pour la raison dite en tête de
 * {@link validationRefusal} : tout appelant de cette fonction a déjà lu la sienne
 * pour en faire la carte d'erreurs de son `safeParse` (#1299), et la relire ici
 * interrogerait la requête deux fois.
 */
export function invalidFromZod(error: ZodError, locale: Locale): AdminActionFailure {
  return invalid(error.issues[0]?.message ?? validationRefusal(locale));
}

/**
 * Refus faute de session — et d'une session qu'on n'a pas pu renouveler.
 *
 * Un cookie d'accès simplement expiré ne produit plus ce refus : l'action le
 * renouvelle sur place avant d'appeler l'API (`adminActionAccess`, #856). Il ne
 * reste donc que les cas où ce renouvellement est impossible — plus de cookie
 * de rafraîchissement, ou jeton refusé par l'API.
 *
 * **Tous** les écrans du back-office réagissent sur `UNAUTHORIZED` — celui-ci,
 * ou le 401 de l'API que `failure()` laisse passer — par le même helper,
 * `useAdminSessionRenewal` : ils partent vers la route de renouvellement, qui
 * pose une session neuve si elle le peut et rend la main sur la page quittée
 * (#48, #458). Elle retombe d'elle-même sur l'écran de connexion quand le jeton
 * de rafraîchissement manque ou que l'API le refuse : c'est là que s'arrête le
 * chemin, et il ne boucle pas (voir `session/refresh/route.ts`).
 *
 * Sa phrase est celle d'`UNAUTHORIZED` dans le contrat partagé (#1234) : elle
 * n'est affichée que si un écran ne sait pas renouveler, et il n'y a aucune
 * raison qu'elle diffère alors de celle que tous les autres refus de session
 * emploient.
 */
export async function expired(): Promise<AdminActionFailure> {
  return {
    ok: false,
    code: ERROR_CODES.UNAUTHORIZED,
    message: errorMessage(ERROR_CODES.UNAUTHORIZED, await getLocale()),
  };
}
