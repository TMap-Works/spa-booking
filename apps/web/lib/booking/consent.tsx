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
 *
 * ## La langue (#846, achevée par #1264)
 *
 * Les phrases vivent dans le catalogue, sous `tunnel.consent`, et elles n'y sont
 * écrites **qu'une fois** pour les deux écrans — c'est la raison d'être de ce
 * fichier, transposée au catalogue. La variante n'en choisit que deux clés,
 * l'introduction et le libellé de la case ; le reste — les finalités, le
 * dépliant, les droits — est commun.
 *
 * #846 n'avait converti que l'étape « Coordonnées » du tunnel : l'inscription
 * cliente, hors de son empreinte, recevait encore une copie toute faite, lue
 * **dans le catalogue français importé en dur**. L'écran rendu en anglais gardait
 * donc trois phrases françaises, et la promesse d'une écriture unique ne tenait
 * que sur le papier — il y en avait bien deux, l'une traduite et l'autre non.
 * #1264 a fait passer l'inscription à `variant`, ce qui a emporté du même geste
 * la copie figée, le traducteur français local et l'import de catalogue : ce
 * module ne lit plus aucun fichier de messages, il n'en demande que les clés.
 *
 * Le lien vers la politique de données est un `t.rich` : c'est un élément JSX au
 * milieu d'une phrase, et le découper en trois chaînes rendrait la phrase
 * intraduisible (modèle `shell.salon.poweredBy`).
 *
 * `consentCopy` prend son traducteur en paramètre plutôt que de le chercher
 * lui-même : la page publique de la politique de données est un Server Component
 * **asynchrone**, et un crochet y serait inappelable. Le composant, lui, est
 * client et lit le catalogue de son côté.
 */

import { useTranslations } from 'next-intl';
import type { InputHTMLAttributes, Ref } from 'react';
import { z } from 'zod';

/**
 * La clé du refus de la case — c'est **elle** que le schéma porte en guise de
 * message, et c'est l'écran qui la traduit au point de rendu (#846).
 *
 * Le schéma est monté hors de React — un `z.object` de module, passé à
 * `zodResolver` — et n'a donc aucun moyen de lire le catalogue ; Zod 3, de son
 * côté, ne prend là qu'une **chaîne**, pas une fonction qu'on rappellerait au
 * rendu. Porter la clé plutôt qu'une phrase est la forme que l'épique #843
 * prescrit à un module pur : il dit **quoi** dire, l'écran dit dans quelle
 * langue.
 *
 * Côté écran, cela tient en une ligne au point de rendu :
 * `error={erreur === undefined ? undefined : t(erreur as typeof CONSENT_ERROR_KEY)}`.
 */
export const CONSENT_ERROR_KEY = 'tunnel.consent.error';

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
 *
 * Son message est la **clé** du refus depuis #846, et non plus la phrase
 * française : voir {@link CONSENT_ERROR_KEY} pour pourquoi, et pour ce que
 * l'écran a à en faire. Sa forme, elle, ne bouge pas — les deux formulaires
 * l'ajoutent au leur exactement comme avant.
 */
export const consentSchema = z.boolean().refine((accepted) => accepted, {
  message: CONSENT_ERROR_KEY,
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

/** Lequel des deux écrans demande le consentement. */
export type ConsentVariant = 'booking' | 'account';

/**
 * Les clés du namespace `booking` que la copie de consentement lit.
 *
 * Énumérées plutôt que déduites d'un gabarit : le traducteur de `next-intl` est
 * typé sur les clés **exactes** du catalogue, et une union plus large que la
 * sienne ne l'accepterait pas en paramètre. La liste fait donc aussi office
 * d'inventaire — ajouter une finalité sans l'écrire dans les deux catalogues
 * échoue à la compilation.
 */
type ConsentMessageKey =
  | 'tunnel.consent.summary'
  | 'tunnel.consent.rights'
  | 'tunnel.consent.booking.intro'
  | 'tunnel.consent.booking.label'
  | 'tunnel.consent.account.intro'
  | 'tunnel.consent.account.label'
  | 'tunnel.consent.purposes.identity.data'
  | 'tunnel.consent.purposes.identity.why'
  | 'tunnel.consent.purposes.email.data'
  | 'tunnel.consent.purposes.email.why'
  | 'tunnel.consent.purposes.emailAccount.why'
  | 'tunnel.consent.purposes.phone.data'
  | 'tunnel.consent.purposes.phone.why'
  | 'tunnel.consent.purposes.note.data'
  | 'tunnel.consent.purposes.note.why'
  | 'tunnel.consent.purposes.password.data'
  | 'tunnel.consent.purposes.password.why';

/**
 * Le traducteur du namespace `booking`, réduit à ce que cette copie demande.
 *
 * Il accepte aussi bien celui de `useTranslations('booking')` que celui d'un
 * `await getTranslations('booking')` : un traducteur qui connaît **plus** de
 * clés se passe pour un traducteur qui en demande moins.
 */
export type ConsentTranslator = (key: ConsentMessageKey) => string;

/**
 * Les finalités communes aux deux écrans, dans l'ordre où les champs se
 * présentent.
 *
 * Communes par construction : la promesse est la même des deux côtés du
 * parcours, et deux rédactions auraient divergé au premier changement de
 * formulation — ce que l'en-tête de ce fichier donne précisément comme motif de
 * le faire exister. Seul le quatrième champ change, et la variante le nomme.
 */
const SHARED_PURPOSE_KEYS = ['identity', 'email', 'phone'] as const;

/**
 * La copie de consentement d'un écran, lue dans le catalogue.
 *
 * Ce qui n'y est écrit **nulle part**, parce que le produit ne le fait pas : la
 * prospection. Le périmètre MVP est figé et n'a ni marketing ni revente
 * (CDC §1.4), et le dire est une information, pas une promesse commerciale —
 * c'est même la première question que pose un formulaire qui demande un
 * téléphone. Depuis #1050 la phrase est **soudée** à l'introduction plutôt que
 * posée en seconde phrase : l'encart faisait huit lignes au-dessus du bouton de
 * l'étape à 360 px, et la moitié de sa hauteur venait de là. Elle reste hors du
 * dépliant — c'est la promesse que la cliente est sûre d'avoir lue au moment où
 * elle coche, et la reléguer derrière un clic aurait été la retirer (CDC §5.1).
 *
 * `rights` porte la troisième exigence de CDC §5.1, *« Mécanismes d'accès, de
 * rectification, d'export et de suppression des données »* : l'espace client y
 * est nommé parce qu'il existe, et le salon à côté parce qu'une cliente qui a
 * réservé sans compte n'a pas d'espace client où aller.
 */
export function consentCopy(t: ConsentTranslator, variant: ConsentVariant): ConsentCopy {
  const shared = SHARED_PURPOSE_KEYS.map((key) => ({
    // Clés construites, et c'est assumé : les trois finalités communes ne
    // diffèrent que par ce segment, et six `t(...)` littéraux diraient six fois
    // la même chose. L'`as` désigne une clé réelle du catalogue, ce que
    // l'inventaire de `ConsentMessageKey` ci-dessus garantit — même détour que
    // `components/ui/locale-switcher.tsx`.
    data: t(`tunnel.consent.purposes.${key}.data` as 'tunnel.consent.purposes.email.data'),
    why:
      key === 'email' && variant === 'account'
        ? // L'adresse sert une chose de plus quand elle ouvre un compte : elle
          // en est l'identifiant. La phrase est écrite en entier dans le
          // catalogue plutôt que concaténée ici — une langue peut avoir à la
          // tourner autrement qu'en ajoutant une phrase à la fin.
          t('tunnel.consent.purposes.emailAccount.why')
        : t(`tunnel.consent.purposes.${key}.why` as 'tunnel.consent.purposes.email.why'),
  }));

  return {
    intro: t(
      variant === 'booking' ? 'tunnel.consent.booking.intro' : 'tunnel.consent.account.intro',
    ),
    summary: t('tunnel.consent.summary'),
    purposes: [
      ...shared,
      variant === 'booking'
        ? {
            data: t('tunnel.consent.purposes.note.data'),
            why: t('tunnel.consent.purposes.note.why'),
          }
        : {
            data: t('tunnel.consent.purposes.password.data'),
            why: t('tunnel.consent.purposes.password.why'),
          },
    ],
    rights: t('tunnel.consent.rights'),
    label: t(
      variant === 'booking' ? 'tunnel.consent.booking.label' : 'tunnel.consent.account.label',
    ),
  };
}

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
  /**
   * Lequel des deux écrans demande l'accord — la copie en découle.
   *
   * Une variante et non la copie elle-même depuis #846 : ce composant est
   * client, il lit donc le catalogue de son côté, et le lui faire passer de
   * l'extérieur obligerait chacun de ses deux appelants à composer la même
   * chose. `consentCopy` reste exportée pour la page publique de la politique
   * de données, qui rend ces finalités hors de tout formulaire.
   *
   * **Obligatoire** depuis #1264. Elle a été facultative le temps que l'écran
   * d'inscription passe de `copy` à `variant` ; l'y laisser maintenant que les
   * deux appelants la donnent rouvrirait le chemin par lequel une copie figée
   * — donc une seconde écriture, non traduite — est revenue à l'écran. Le type
   * est ce qui tient le deuxième critère de #1264 : une troisième surface de
   * consentement ne peut plus naître sans dire laquelle elle est.
   */
  readonly variant: ConsentVariant;
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
export function ConsentField({ id, variant, tenantSlug, error, ref, ...input }: ConsentFieldProps) {
  const t = useTranslations('booking');
  // Le texte vient du catalogue, et de lui seul : les deux écrans de
  // consentement lisent la **même** écriture, dans la langue de la requête
  // (#1264).
  const copy = consentCopy(t, variant);
  const introId = `${id}-finalites`;
  const errorId = `${id}-error`;
  /*
   * Le refus de la case arrive parfois sous forme de **clé** (#846).
   *
   * `consentSchema` est bâti hors de React et ne peut pas traduire son propre
   * message : il porte `CONSENT_ERROR_KEY`, et c'est un point de rendu qui le
   * convertit. Le faire **ici** plutôt que chez chaque appelant est ce qui
   * permet aux deux écrans de passer `errors.dataConsent?.message` tel quel
   * sans afficher une clé brute à qui réserve ou s'inscrit.
   *
   * Une phrase déjà traduite passe au travers : elle n'est pas la clé.
   */
  const message = error === CONSENT_ERROR_KEY ? t(CONSENT_ERROR_KEY) : error;
  const describedBy = [introId, message === undefined ? null : errorId]
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
              ce paragraphe sans qu'on ait à le redire.

              `t.rich` et non deux chaînes autour d'une balise : le libellé et sa
              parenthèse se traduisent d'un bloc, et la langue reste libre de
              placer la mention du nouvel onglet où elle l'entend (modèle
              `shell.salon.poweredBy`). */}
          {t.rich('tunnel.consent.policyLink', {
            policy: (chunks) => (
              <a href={dataPolicyPath(tenantSlug)} target="_blank" rel="noopener noreferrer">
                {chunks}
              </a>
            ),
          })}
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
          aria-invalid={message === undefined ? undefined : true}
          aria-describedby={describedBy}
        />
        <label className="spa-consent__label" htmlFor={id}>
          {copy.label}
        </label>
      </div>

      {message === undefined ? null : (
        <p id={errorId} className="spa-consent__error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
