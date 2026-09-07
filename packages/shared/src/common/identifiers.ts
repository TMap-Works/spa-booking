/**
 * Primitives d'identification et de coordonnées.
 *
 * Toutes les longueurs viennent de `../constants/limits` — jamais d'un littéral
 * recopié ici : une borne écrite à deux endroits finit par diverger, et c'est
 * l'écart entre la borne du front et la largeur de la colonne qui produit un
 * 500 là où l'utilisateur attendait un message de champ.
 */

import { z } from 'zod';

import {
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_ADDRESS_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PHONE_MAX_LENGTH,
  PHONE_MIN_DIGITS,
  REASON_MAX_LENGTH,
  SLUG_MAX_LENGTH,
} from '../constants/limits';

/**
 * Motif d'un UUID **version 4** — quatrième groupe préfixé de `4`, cinquième
 * groupe dont le premier caractère porte la variante RFC 4122 (`8`, `9`, `a` ou
 * `b`).
 *
 * Il exclut au passage l'UUID nil (`00000000-…`), que `z.string().uuid()`
 * acceptait : ce n'est l'identifiant d'aucune ressource, et le laisser traverser
 * la frontière transforme une valeur par défaut oubliée en requête légitime.
 */
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Identifiant de ressource — UUID **v4**, généré côté application.
 *
 * Le choix de l'UUID sur un entier séquentiel n'est pas esthétique : un
 * identifiant énumérable est un vecteur de fuite inter-tenant à part entière.
 * Avec `/appointments/1`, `/appointments/2`, il suffit d'incrémenter pour
 * sonder l'existence des rendez-vous des autres établissements.
 *
 * ## Pourquoi la v4 et pas « n'importe quelle version » — #403, tranché par #404
 *
 * Ce schéma était `z.string().uuid()`, qui accepte **toutes** les versions, là
 * où tous les DTO de l'API validaient avec `@IsUUID('4')`. C'était la même
 * classe de défaut que celui que #401 a refermé sur `emailSchema` : **le contrat
 * plus permissif que l'API qu'il décrit**, donc un formulaire qui déclare bon un
 * identifiant que la route refuse en 400.
 *
 * #404 substitue ce schéma aux décorateurs sur le tunnel public
 * ([ADR 0008](../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)),
 * ce qui rend l'écart immédiatement effectif : le laisser permissif aurait
 * **relâché** la frontière de l'API, plutôt que de la laisser où elle est. Des
 * deux corrections que #403 proposait, c'est donc le resserrement qui est
 * retenu — le seul des deux qui ne change le comportement d'aucune route.
 *
 * Il est sans risque sur le stock : les dix-neuf identifiants du schéma Prisma
 * viennent tous de `@default(uuid())`, qui produit une v4, et aucun littéral
 * d'une autre version ne subsiste dans `apps/` ni `packages/`. Le sens de
 * lecture compte, ici comme sur les bornes d'adresse : un contrat plus strict
 * que l'API ne coûte qu'un refus plus tôt, du bon côté de l'écran ; un contrat
 * plus permissif coûte un 400 qu'il venait d'annoncer impossible.
 *
 * Le motif remplace `.uuid()` au lieu de s'y ajouter, pour la raison qui a
 * dicté l'alternative `[^@]*$` d'`emailSchema` : deux vérifications qui échouent
 * ensemble produisent deux `issues` de même message, et un formulaire qui les
 * rend toutes afficherait « identifiant attendu au format UUID v4 » deux fois
 * sous le même champ. Le motif de la v4 est de toute façon plus strict que celui
 * de `.uuid()` — il n'y a rien qu'il laisserait passer.
 */
export const uuidSchema = z
  .string()
  .regex(UUID_V4_PATTERN, { message: 'identifiant attendu au format UUID v4' });

export type Uuid = z.infer<typeof uuidSchema>;

/**
 * Slug d'URL — label DNS minuscule, utilisé par les pages de réservation
 * publiques (`{slug}.exemple.test` ou `/{slug}`).
 *
 * Ni tiret en tête ni tiret en fin : `-salon` n'est pas un label DNS valide, et
 * la page publique du tenant deviendrait injoignable.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug attendu en minuscules, chiffres et tirets simples',
  });

export type Slug = z.infer<typeof slugSchema>;

/**
 * Adresse e-mail, **canonisée ici** : espaces retirés, casse abaissée.
 *
 * Le faire dans le schéma partagé et non dans chaque appelant est ce qui rend
 * l'unicité `(tenant_id, email)` fiable. La contrainte de base porte sur les
 * octets : sans normalisation en amont, `Alice@Example.test` et
 * `alice@example.test` cohabiteraient dans le même salon et la recherche à la
 * connexion n'en trouverait qu'une — l'autre compte deviendrait inatteignable
 * sans jamais avoir déclenché la moindre erreur.
 *
 * ## Les deux bornes de longueur de la RFC 5321 — #314
 *
 * `.email()` de Zod ne juge aucune longueur : il accepte une partie locale de
 * trois cents caractères, et une adresse aussi longue que la chaîne le permet.
 * Les DTO de l'API, eux, valident avec `@IsEmail()`, dont validator.js porte les
 * deux bornes de la RFC en dur — **254 octets** pour l'adresse entière
 * (§4.5.3.1.3), **64** pour la partie locale (§4.5.3.1.1).
 *
 * Sans elles, le contrat serait **plus permissif que l'API qu'il décrit**, et
 * c'est le sens dangereux de l'écart : un formulaire qui valide avec ce schéma
 * déclarerait l'adresse bonne, l'enverrait, et récolterait un 400 qu'il vient
 * lui-même d'annoncer impossible. Le sens inverse — un contrat plus strict — ne
 * coûte qu'un refus plus tôt, du bon côté de l'écran. C'est pourquoi la borne
 * appliquée ici est `EMAIL_ADDRESS_MAX_LENGTH` (254) et non `EMAIL_MAX_LENGTH`
 * (320), qui est la largeur de la colonne.
 *
 * Le motif n'est pas une seconde validation d'adresse : il ne juge que la
 * position du premier `@`, `.email()` gardant tout le reste. Son alternative
 * `[^@]*$` est ce qui l'empêche de **doubler** le refus de `.email()` sur une
 * chaîne sans `@` : deux checks qui échouent produisent deux `issues` de même
 * message, et un formulaire qui les rend toutes affiche « adresse e-mail
 * invalide » deux fois sous le même champ.
 *
 * Ce que ces bornes ne couvrent **pas**, et qui reste à l'avantage de l'API :
 * validator.js refuse aussi un label de domaine de plus de 63 octets. Le
 * reproduire ici demanderait de redécouper le domaine, c'est-à-dire de valider
 * l'adresse une seconde fois — l'écart est laissé en l'état, un tel domaine
 * n'étant pas enregistrable.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_ADDRESS_MAX_LENGTH)
  .email({ message: 'adresse e-mail invalide' })
  .regex(/^(?:[^@]{0,64}@|[^@]*$)/, { message: 'adresse e-mail invalide' });

export type Email = z.infer<typeof emailSchema>;

/**
 * Numéro de téléphone — format libre borné à ce stade du MVP.
 *
 * Volontairement permissif : la validation stricte d'un numéro dépend du pays et
 * demande une table de plans de numérotation. Refuser un numéro pourtant valide
 * empêche une réservation ; en accepter un douteux ne coûte qu'un SMS non
 * délivré, que la chaîne de notifications sait déjà journaliser.
 *
 * **Ce schéma décrit le stock, pas une saisie**, et c'est la raison pour laquelle
 * il n'a pas de plancher de chiffres. Toute réponse de l'API portant un `phone`
 * est validée avec lui côté front (`apps/web/lib/api-client.ts`), qui lève un
 * `INTERNAL_ERROR` et fait échouer la page entière au moindre refus. Une écriture
 * antérieure à une règle qu'on durcirait ici — un `+` saisi au comptoir avant
 * #66, que les DTO `class-validator` de l'API acceptent toujours — rendrait donc
 * illisibles la fiche cliente, la page publique du salon et jusqu'à la réponse de
 * connexion. Le durcissement appartient à la saisie, et il vit dans
 * `phoneSchema` ci-dessous.
 */
export const storedPhoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(PHONE_MAX_LENGTH)
  .regex(/^[+0-9][0-9\s().-]*$/, { message: 'numéro de téléphone invalide' });

/**
 * Numéro de téléphone **saisi** — `storedPhoneSchema` plus un plancher de
 * chiffres.
 *
 * Permissif n'est pas complaisant, et c'est ce que `PHONE_MIN_DIGITS` corrige
 * (#66) : le motif seul accepte `+` ou `+ ()`, qui ne portent aucun chiffre
 * composable, et `0`, qui n'en porte pas assez pour l'être. Un tel champ
 * traversait la saisie, la fiche cliente et la file d'envoi pour n'être reconnu
 * comme inexploitable qu'au moment où il aurait fallu l'utiliser — trop tard
 * pour le redemander à qui le connaissait.
 *
 * Le plancher ne vaut qu'**en entrée** : schémas de requête et formulaires
 * d'`apps/web`, qui importent ce schéma directement, si bien que le refus
 * s'affiche sur le champ. Les schémas de réponse prennent `storedPhoneSchema` —
 * voir son commentaire pour ce qui se casserait sinon.
 */
export const phoneSchema = storedPhoneSchema.refine(
  (value) => (value.match(/\d/g) ?? []).length >= PHONE_MIN_DIGITS,
  {
    message: `numéro de téléphone incomplet — au moins ${PHONE_MIN_DIGITS} chiffres attendus`,
  },
);

export type Phone = z.infer<typeof phoneSchema>;

/**
 * Motif E.164 — `+`, un indicatif de pays qui ne commence pas par zéro, et
 * quinze chiffres significatifs au plus (recommandation UIT-T E.164).
 */
export const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/**
 * Ce qu'un humain intercale dans un numéro et qui ne porte aucune information :
 * espaces, points, tirets, parenthèses d'indicatif régional.
 */
const PHONE_SEPARATORS = /[\s().-]/g;

/**
 * Ramène un numéro saisi à sa forme E.164, ou rend `null` s'il n'y a pas de
 * forme E.164 déductible **sans deviner un pays**.
 *
 * Deux écritures internationales entrent : `+261341234567` et `00261341234567`
 * — le préfixe `00` est la forme que composent la plupart des plans de
 * numérotation, `+` celle qu'exige E.164. Les séparateurs sont retirés.
 *
 * Ce qui n'entre **pas**, et c'est le point : un numéro national comme
 * `0341234567`. Le compléter demanderait de connaître le pays de la personne,
 * que rien dans la requête ne dit — ni le fuseau du salon, qui n'est pas un
 * pays, ni la langue du navigateur. Deviner produirait un numéro
 * syntaxiquement valide et faux, c'est-à-dire un SMS de rappel envoyé à
 * quelqu'un d'autre. Refuser laisse la correction à la seule personne qui
 * connaisse la réponse, et le formulaire l'annonce dans son libellé d'aide.
 */
export function normalizeToE164(value: string): string | null {
  const compact = value.trim().replace(PHONE_SEPARATORS, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;

  return E164_PATTERN.test(withPlus) ? withPlus : null;
}

/**
 * Numéro de téléphone **normalisé en E.164**, pour les surfaces où le numéro
 * sert à joindre quelqu'un plutôt qu'à être affiché tel qu'il a été tapé.
 *
 * Distinct de `phoneSchema`, et la distinction n'est pas cosmétique :
 *
 * - `phoneSchema` est **permissif et conservateur** — il accepte la saisie d'un
 *   comptoir, qui recopie ce qu'une cliente dicte, et la garde telle quelle ;
 * - `e164PhoneSchema` **transforme** — passé la frontière, le numéro a une seule
 *   écriture, celle qu'attend un opérateur SMS. `+261 34 12 345 67`,
 *   `+261-34-12-345-67` et `00261341234567` y deviennent le même numéro, donc
 *   le même destinataire et la même clé de déduplication d'envoi.
 *
 * Le plafond de longueur porte sur la saisie **avant** normalisation : c'est
 * elle qui doit tenir dans `VARCHAR(32)` si un appelant la conserve, et la forme
 * normalisée est de toute façon plus courte.
 *
 * ## Quelle surface prend lequel — la décision de #66
 *
 * Le critère de l'issue est « numéros normalisés en E.164 ; un numéro non
 * normalisable est refusé à la saisie ». Appliqué partout sans distinction, il
 * ferait plus de mal que de bien : le répartir demande de séparer les surfaces
 * qui **composent** un numéro de celles qui l'**enregistrent** ou l'affichent.
 *
 * | Surface | Schéma | Pourquoi |
 * |---|---|---|
 * | `guestContactSchema` — coordonnées du tunnel public | `e164PhoneSchema` | Le seul numéro que la chaîne SMS compose sans qu'aucun humain le relise |
 * | Toute réponse de l'API portant un `phone` | `storedPhoneSchema` | Décrit le **stock**, pas une saisie. Une écriture antérieure à cette règle rendrait la page entière illisible si le schéma la refusait |
 * | `contactPhone` d'un établissement | `phoneSchema` | Numéro **affiché** à la cliente, jamais composé par SNS. Le normaliser retirerait les espaces d'un numéro fait pour être lu |
 * | Fiche cliente, inscription, profil, compte staff | `phoneSchema` | Voir ci-dessous — la règle vaut, la marche est ailleurs |
 *
 * La dernière ligne est un constat, pas un renoncement, et elle mérite son
 * explication. Ces quatre surfaces alimentent bien le canal SMS, et la règle
 * devrait s'y appliquer. Mais chacune est saisie par un formulaire d'`apps/web`
 * qui **redéclare** son champ `phone` sur `phoneSchema` — puis postée à une
 * action serveur qui, elle, valide avec le schéma de requête. Resserrer le
 * schéma de requête seul déplacerait donc le refus **après** la soumission, sous
 * la forme d'un message global en tête de page, pour un numéro que le champ
 * venait d'accepter. C'est exactement ce que la skill web-frontend §4 interdit :
 * un message d'erreur appartient à son champ.
 *
 * La marche à faire est donc d'un seul tenant — schéma de requête **et**
 * formulaire — et elle appartient à `apps/web`, hors de l'empreinte de #66. Elle
 * rejoint la décision de #404, dont le critère est justement de trancher « le
 * téléphone (E.164 contre format libre) » lors de la substitution des DTO de
 * l'API : les trois écritures de la règle — contrat partagé, DTO `class-validator`,
 * formulaire — doivent bouger ensemble ou pas du tout.
 *
 * Ce que #66 tranche en attendant, et qui ne dépend d'aucune des deux : le
 * plancher de `phoneSchema` (`PHONE_MIN_DIGITS`), qui refuse dès la saisie ce
 * qui n'est un numéro dans aucune convention. Les formulaires importent ce
 * schéma-là **directement**, si bien que le refus s'affiche sur le champ, où il
 * doit être. Le plancher s'arrête à la saisie : les schémas de réponse gardent
 * `storedPhoneSchema`, sans quoi le durcissement rendrait illisible le stock
 * écrit avant lui.
 */
export const e164PhoneSchema = z
  .string()
  .trim()
  .max(PHONE_MAX_LENGTH)
  .transform((value, ctx): string => {
    const normalized = normalizeToE164(value);

    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'numéro attendu au format international, indicatif compris — par exemple +261 34 12 345 67',
      });

      return z.NEVER;
    }

    return normalized;
  });

export type E164Phone = z.infer<typeof e164PhoneSchema>;

/** Prénom, nom, catégorie — `VARCHAR(80)`. */
export const nameSchema = z.string().trim().min(1).max(NAME_MAX_LENGTH);

/** Nom d'établissement, de prestation, nom public de praticien — `VARCHAR(160)`. */
export const displayNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH);

/** Description, biographie, note de rendez-vous — `VARCHAR(2000)`. */
export const longTextSchema = z.string().trim().max(LONG_TEXT_MAX_LENGTH);

/** Motif d'annulation, cause d'échec d'envoi — `VARCHAR(500)`. */
export const reasonSchema = z.string().trim().max(REASON_MAX_LENGTH);

/**
 * Mot de passe en clair — **uniquement en entrée**, jamais en sortie.
 *
 * Aucun schéma de réponse de ce paquet ne porte ce champ, ni `passwordHash` :
 * c'est une propriété qu'on veut pouvoir vérifier en lisant les types, pas
 * seulement en relisant les contrôleurs.
 *
 * Pas de `.trim()` ici, contrairement aux autres chaînes : une espace en tête ou
 * en fin fait partie du secret choisi par l'utilisateur. La retirer en silence
 * rendrait le mot de passe irreproductible depuis un gestionnaire de mots de
 * passe qui, lui, ne la retire pas.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, {
    message: `le mot de passe fait au moins ${String(PASSWORD_MIN_LENGTH)} caractères`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    message: `le mot de passe fait au plus ${String(PASSWORD_MAX_LENGTH)} caractères`,
  });

/**
 * Mot de passe **soumis à vérification** — la connexion, la confirmation du mot
 * de passe courant. Distinct de `passwordSchema`, et la distinction n'est pas
 * cosmétique :
 *
 * - la politique de longueur s'applique au moment où le secret est **choisi**,
 *   pas à celui où il est **vérifié**. Relever `PASSWORD_MIN_LENGTH` un jour
 *   verrouillerait sinon définitivement tout compte dont le secret est
 *   antérieur au durcissement : sa connexion sortirait en 422 sans qu'aucun
 *   chemin ne lui permette de se réauthentifier pour en changer ;
 * - un refus de longueur à la connexion **divulgue la politique** et distingue
 *   un mot de passe mal formé d'un mot de passe faux, là où le contrat exige un
 *   `INVALID_CREDENTIALS` indistinct.
 *
 * Le plafond, lui, reste : c'est une borne de coût argon2id, pas une règle de
 * composition.
 */
export const submittedPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/**
 * Jeton opaque — jeton d'accès, de rafraîchissement, ou secret client d'un
 * paiement. Non introspecté par le contrat : sa structure appartient à son
 * émetteur.
 */
export const opaqueTokenSchema = z.string().min(1);
