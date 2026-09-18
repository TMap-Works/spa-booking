/**
 * L'information et le consentement exigés avant toute collecte de données
 * personnelles dans le parcours client (#734).
 *
 * ## La référence
 *
 * CDC §5.1, « Principes de protection des données » : *« Consentement et
 * finalités. Information claire des utilisateurs, base légale explicite pour
 * chaque traitement (notifications, marketing ultérieur). »* Et
 * `docs/design/appointments/wireframes.md`, étape 4, qui dessine la case à
 * cocher — *« [ ] J'accepte les CGV et la politique de données — consentement
 * RGPD explicite »* — juste au-dessus du bouton de l'étape.
 *
 * Deux écrans collectent ces données et n'en disaient rien : l'étape
 * « Coordonnées » du tunnel, qui demande identité, e-mail, téléphone **et un
 * champ libre où le jeu d'essai montre une allergie** — donc une donnée de
 * santé —, et la création de compte. Les deux servent le même produit, et une
 * cliente passe de l'un à l'autre sans changer de site : elle doit y lire la
 * même chose.
 *
 * ## Les finalités sont écrites en place, **et** la page publique est liée
 *
 * La direction d'audit proposait « un lien vers la politique de données ». #734
 * a porté l'information **en place** faute de page à lier : une phrase toujours
 * visible qui dit à quoi servent ces données, et un dépliant qui les reprend
 * champ par champ, avec la base légale de chacun et la façon d'exercer ses
 * droits. Rien n'est à charger, rien ne fait quitter un formulaire à moitié
 * rempli — ce que la §3 de la skill `web-frontend` reproche précisément à une
 * sortie de tunnel.
 *
 * La page existe depuis #790 (`/{salon}/politique-donnees`), et le dépliant n'a
 * pas disparu pour autant : il reste ce qui se lit **sans cliquer**, et c'est le
 * seul texte que la cliente est sûre d'avoir sous les yeux au moment où elle
 * coche. Le lien s'ajoute à côté, pour qui veut le texte complet — l'un ne
 * remplace pas l'autre, et la §3 vaut toujours : il s'ouvre dans un **nouvel
 * onglet**, de sorte que le tunnel à moitié rempli reste là où il était.
 *
 * ## Pourquoi sous `lib/booking/`
 *
 * C'est le seul endroit partagé par les deux écrans qui l'affichent, l'un dans
 * le groupe de routes `(booking)` et l'autre dans `(account)`. Un composant par
 * groupe aurait donné deux formulations de la même promesse, et la seconde
 * aurait divergé au premier changement de texte. Le consentement porte sur le
 * même traitement — réserver, confirmer, rappeler — quelle que soit la porte par
 * laquelle on entre.
 */

import type { InputHTMLAttributes, Ref } from 'react';
import { z } from 'zod';

/**
 * La case cochée, et rien d'autre.
 *
 * `refine` plutôt que `z.literal(true)` pour une raison de message : le refus
 * littéral de Zod 3 s'annonce « Invalid literal value, expected true », et un
 * message de champ se lit par la cliente, pas par le développeur.
 *
 * C'est ce schéma qui rend le consentement **bloquant** : les deux formulaires
 * l'ajoutent au leur, et `react-hook-form` refuse la soumission tant qu'il n'est
 * pas satisfait — le geste est donc impossible à sauter, là où un simple
 * `required` HTML aurait été neutralisé par le `noValidate` que les deux
 * formulaires portent déjà.
 */
export const consentSchema = z.boolean().refine((accepted) => accepted, {
  message:
    'cochez cette case pour continuer : sans votre accord, nous ne pouvons pas traiter vos données',
});

/**
 * L'adresse de la politique de données d'un établissement (#790).
 *
 * ## Pourquoi ici, et non dans `salon-data.ts` ou dans `compte/paths.ts`
 *
 * Parce que c'est le seul module que les **deux** écrans de consentement
 * importent déjà, l'un dans le groupe de routes `(booking)` et l'autre dans
 * `(account)` — la raison même qui a fait naître ce fichier, écrite en son
 * en-tête. Le chemin posé dans l'un des deux groupes aurait obligé l'autre à
 * l'importer à travers la frontière, ou à le réécrire ; et deux écritures d'une
 * même URL, c'est un lien mort le jour où la route bouge.
 *
 * `encodeURIComponent` comme les chemins voisins (`compte/paths.ts`) : le slug
 * vient d'un segment d'URL et rien ne garantit qu'il soit inoffensif.
 */
export function dataPolicyPath(tenantSlug: string): string {
  return `/${encodeURIComponent(tenantSlug)}/politique-donnees`;
}

/** Une donnée demandée, et ce à quoi elle sert. */
interface ConsentPurpose {
  /** Le champ, nommé comme son libellé à l'écran. */
  readonly data: string;
  /** Sa finalité, puis sa base légale — « nécessaire à… », « facultatif… ». */
  readonly why: string;
}

export interface ConsentCopy {
  /** La phrase toujours visible : à quoi servent ces données, en une fois. */
  readonly intro: string;
  /** Ce qu'annonce le dépliant. */
  readonly summary: string;
  /** Le détail, champ par champ. */
  readonly purposes: readonly ConsentPurpose[];
  /** Conservation et droits des personnes (CDC §5.1). */
  readonly rights: string;
  /** Le libellé de la case — ce que la cliente accepte exactement. */
  readonly label: string;
}

/**
 * Ce qui n'est écrit nulle part parce que le produit ne le fait pas : la
 * prospection. Le périmètre MVP est figé et n'a ni marketing ni revente
 * (CDC §1.4), et le dire est une information, pas une promesse commerciale —
 * c'est même la première question que pose un formulaire qui demande un
 * téléphone.
 *
 * Depuis #1050 la phrase est **soudée à celle qui la précède** plutôt que posée
 * en seconde phrase : l'encart faisait huit lignes au-dessus du bouton de
 * l'étape à 360 px, et la moitié de sa hauteur venait de là. Elle reste
 * néanmoins **hors du dépliant** — c'est la promesse que la cliente est sûre
 * d'avoir lue au moment où elle coche, et la reléguer derrière un clic aurait
 * été la retirer (CDC §5.1).
 */
const NO_MARKETING = 'et à rien d’autre : aucune prospection, aucune revente.';

const IDENTITY_PURPOSE: ConsentPurpose = {
  data: 'Prénom et nom',
  why: 'identifier votre rendez-vous auprès du salon. Nécessaires : sans eux, il n’y a pas de réservation à honorer.',
};

const EMAIL_PURPOSE: ConsentPurpose = {
  data: 'Adresse e-mail',
  why: 'vous envoyer la confirmation, puis tout avis d’annulation ou de report. Nécessaire : c’est le canal par lequel le salon vous répond.',
};

const PHONE_PURPOSE: ConsentPurpose = {
  data: 'Téléphone',
  why: 'vous envoyer par SMS le rappel de la veille. Facultatif : sans numéro, le rappel arrive par e-mail seulement.',
};

/**
 * Ce qu'annonce le dépliant, écrit une fois pour les deux écrans.
 *
 * Même raison que `NO_MARKETING` ci-dessus : la phrase est la même des deux
 * côtés du parcours, et deux copies auraient divergé au premier changement de
 * formulation — ce que l'en-tête de ce fichier donne précisément comme motif de
 * le faire exister.
 */
const SUMMARY = 'Ce que nous faisons de vos données';

/**
 * Conservation et droits — la troisième exigence de CDC §5.1, *« Mécanismes
 * d'accès, de rectification, d'export et de suppression des données »*.
 *
 * L'espace client est nommé parce qu'il existe : `/{salon}/compte/coordonnees`
 * rectifie, et l'export comme la suppression sont servis par l'API depuis #81.
 * Le salon est nommé à côté parce qu'une cliente qui a réservé sans compte n'a
 * pas d'espace client où aller.
 */
const RIGHTS =
  'L’établissement conserve ces données le temps du suivi de sa clientèle. ' +
  'Vous pouvez les consulter, les corriger ou en demander la suppression à tout ' +
  'moment, depuis votre espace client ou en écrivant à l’établissement.';

/** L'étape « Coordonnées » du tunnel — wireframes.md, étape 4. */
export const BOOKING_CONSENT: ConsentCopy = {
  intro:
    'Vos coordonnées servent à gérer ce rendez-vous — confirmation par e-mail, ' +
    `rappel la veille par SMS si vous laissez un numéro — ${NO_MARKETING}`,
  summary: SUMMARY,
  purposes: [
    IDENTITY_PURPOSE,
    EMAIL_PURPOSE,
    PHONE_PURPOSE,
    {
      data: 'Le mot pour le salon',
      why: 'transmettre au praticien ce qu’il doit savoir pour la prestation. Facultatif : n’y écrivez qu’une information dont le salon a besoin ce jour-là.',
    },
  ],
  rights: RIGHTS,
  label:
    'J’ai lu ces informations et j’accepte que mes données soient utilisées pour ce rendez-vous.',
};

/** La création de compte — `/{salon}/compte/inscription`. */
export const ACCOUNT_CONSENT: ConsentCopy = {
  intro:
    'Vos coordonnées servent à tenir votre compte et vos rendez-vous — ' +
    'connexion, historique, confirmations par e-mail, rappels par SMS si vous ' +
    `laissez un numéro — ${NO_MARKETING}`,
  summary: SUMMARY,
  purposes: [
    IDENTITY_PURPOSE,
    {
      ...EMAIL_PURPOSE,
      why: `${EMAIL_PURPOSE.why} C’est aussi votre identifiant de connexion.`,
    },
    PHONE_PURPOSE,
    {
      data: 'Mot de passe',
      why: 'protéger l’accès à votre compte. Nécessaire, et conservé sous forme chiffrée : personne, dans l’établissement comme chez nous, ne peut le relire.',
    },
  ],
  rights: RIGHTS,
  label:
    'J’ai lu ces informations et j’accepte que mes données soient utilisées pour gérer mon compte et mes rendez-vous.',
};

/**
 * `checked` et `defaultChecked` sont retirés au même titre que `type` et `id` :
 * ce ne sont pas des détails de rendu que le composant se réserve, c'est la
 * règle du ticket tenue par le type. Un consentement pré-coché n'est pas un
 * consentement (#734, CDC §5.1), et un appelant qui déverserait ici un objet de
 * props porteur d'un `defaultChecked` en livrerait un sans que rien ne
 * l'arrête. L'état de la case vient de `react-hook-form`, et de lui seul.
 */
interface ConsentFieldProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'checked' | 'className' | 'defaultChecked' | 'id' | 'type'
  > {
  readonly id: string;
  readonly copy: ConsentCopy;
  /**
   * L'établissement dont on lit la politique de données (#790).
   *
   * Obligatoire, et non facultatif : la page est servie **par salon**
   * (`/{salon}/politique-donnees`), il n'existe pas d'adresse générique vers
   * laquelle se rabattre, et un lien absent est exactement ce que le quatrième
   * critère de #790 demande de corriger. Le rendre facultatif aurait laissé un
   * troisième écran de consentement naître sans lien, sans que rien ne
   * l'arrête.
   */
  readonly tenantSlug: string;
  /**
   * Le message de refus **de cette case**, rendu sous elle et référencé par
   * `aria-describedby` — jamais en bloc en haut de page (skill `web-frontend`
   * §4), exactement comme `Field` le fait pour les autres champs de ces deux
   * formulaires.
   */
  readonly error?: string | undefined;
  readonly ref?: Ref<HTMLInputElement>;
}

/**
 * La mention des finalités et la case de consentement, d'un seul bloc.
 *
 * Les deux vont ensemble et se rendent ensemble : une case cochée sans
 * information n'est pas un consentement éclairé, et une information sans case
 * n'est pas un consentement. Le `<details>` porte le détail parce qu'il le fait
 * nativement — ouverture au clavier, état annoncé, contenu trouvé par la
 * recherche du navigateur — là où une bascule maison redemanderait `aria-expanded`
 * et la gestion du focus pour, au mieux, le même résultat.
 *
 * La case n'est pas cochée d'avance, et ne peut pas l'être : un consentement
 * pré-coché n'est pas un consentement, et le schéma ci-dessus exige un `true`
 * que seule la cliente peut poser.
 *
 * ## Pourquoi la case est sortie de l'encart gris (#1050)
 *
 * `BM-TUNNEL-06` (`docs/design/benchmark/parcours-client.md`) : *« toute case
 * facultative […] est décochée par défaut, **séparée** de l'acceptation des
 * conditions de réservation »*. La case vivait jusqu'ici **dans** le pavé
 * d'information, au même fond et au même cadre : à 360 px, le geste qui engage
 * se lisait comme la dernière ligne d'un paragraphe juridique, et l'audit
 * `d20260918-1` l'a relevé comme tel.
 *
 * Elle est donc désormais sœur de l'encart, et non son enfant : l'information
 * garde son fond creusé — c'est un texte à lire, pas une saisie —, la décision
 * se pose sur le fond du formulaire, comme les autres contrôles. Les deux
 * restent dans le même conteneur, et le même `aria-describedby` continue de
 * rattacher l'une à l'autre : rien ne change pour un lecteur d'écran, qui
 * annonce toujours les finalités avec la case.
 */
export function ConsentField({ id, copy, tenantSlug, error, ref, ...input }: ConsentFieldProps) {
  const introId = `${id}-finalites`;
  const errorId = `${id}-error`;
  const describedBy = [introId, error === undefined ? null : errorId]
    .filter((value) => value !== null)
    .join(' ');

  return (
    <div className="spa-consent">
      {/* L'encart d'information — ce qu'il faut avoir lu, et rien qui se saisit. */}
      <div className="spa-consent__notice">
        <p className="spa-consent__intro" id={introId}>
          {copy.intro}{' '}
          {/*
            Le lien vit **dans** le paragraphe d'intro, et non dans le libellé de
            la case : un lien à l'intérieur d'un `<label>` est activé par le clic
            qui coche, et la cliente se retrouverait sur une autre page en croyant
            consentir. Ce paragraphe est par ailleurs la cible d'`aria-describedby`
            ci-dessous, si bien que le lien fait partie de ce qu'un lecteur d'écran
            annonce avec la case.

            `target="_blank"` pour la raison écrite en tête de fichier : le tunnel
            est à moitié rempli, et rien de ce qui informe ne doit le faire perdre.
            `rel` va avec — une page ouverte par `_blank` sans lui garde une prise
            sur celle qui l'a ouverte. La mention entre parenthèses est écrite en
            toutes lettres plutôt que laissée à un attribut : c'est ce que voit
            aussi la personne qui n'a pas de lecteur d'écran, et c'est elle qu'un
            nouvel onglet surprend.
          */}
          {/* Aucune classe : le socle (`styles/base.css`) donne déjà à tout `a` la
              couleur d'accent et le soulignement, et une classe sans règle est une
              promesse de style que rien ne tient. Le lien ressort donc du gris de
              ce paragraphe sans qu'on ait à le redire. */}
          <a href={dataPolicyPath(tenantSlug)} target="_blank" rel="noopener noreferrer">
            Lire la politique de données (nouvel onglet)
          </a>
        </p>

        <details className="spa-consent__details">
          <summary className="spa-consent__summary">{copy.summary}</summary>
          {/* `spa-list` rend la puce et le retrait que le socle retire à toute
              liste (styles/base.css) : celle-ci est une liste de prose, pas une
              suite d'éléments d'interface. */}
          <ul className="spa-list spa-consent__list">
            {copy.purposes.map((purpose) => (
              <li key={purpose.data}>
                <span className="spa-consent__data">{purpose.data}</span> — {purpose.why}
              </li>
            ))}
          </ul>
          <p className="spa-consent__rights">{copy.rights}</p>
        </details>
      </div>

      <div className="spa-consent__choice">
        <input
          {...input}
          type="checkbox"
          id={id}
          ref={ref}
          className="spa-consent__control"
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy}
        />
        <label className="spa-consent__label" htmlFor={id}>
          {copy.label}
        </label>
      </div>

      {error === undefined ? null : (
        <p id={errorId} className="spa-consent__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
