'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { e164PhoneSchemaFor, guestContactSchemaFor, longTextSchema } from '@spa/shared';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { BookingActionBar, type BookingSummary } from '@/components/booking/summary-bar';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { TextArea } from '@/components/ui/textarea';
import type { AccountPresence } from '@/lib/account-presence';
import { BOOKING_CONSENT, ConsentField, consentSchema } from '@/lib/booking/consent';
import type { ContactDraft } from '@/lib/booking/draft';

import { useDraftAutosave } from '../use-draft-autosave';

/**
 * Le schéma du formulaire **dérive** du contrat, il ne le réécrit pas.
 *
 * Les règles de fond — longueurs des noms, adresse e-mail, format E.164 du
 * téléphone — viennent de `guestContactSchemaFor`, qui est aussi ce que la
 * frontière serveur applique. Deux ajustements, et deux seulement, tiennent à la nature
 * d'un formulaire HTML :
 *
 * 1. **un champ non rempli vaut la chaîne vide**, pas `undefined`. Le téléphone
 *    est facultatif : la chaîne vide est donc une valeur valable, distincte d'un
 *    numéro mal formé ;
 * 2. **le mot au salon** (`clientNote`) accompagne les coordonnées dans le même
 *    écran, alors qu'il appartient à la demande de réservation et non à la fiche
 *    cliente.
 *
 * Écrire ces deux ajustements ici plutôt que d'assouplir le contrat garde la
 * règle stricte là où elle protège : au moment de composer la requête.
 *
 * S'y ajoute depuis #734 le **consentement**, qui n'est ni l'un ni l'autre : il
 * n'est pas une donnée que l'API reçoit — aucun champ du contrat ne le porte —
 * mais la condition pour la lui envoyer (CDC §5.1). Il vit donc dans le schéma
 * du formulaire, qui est l'endroit exact où se décide si la soumission a lieu.
 *
 * ## Pourquoi une fabrique, depuis #1028
 *
 * Parce que la règle du téléphone dépend désormais du **pays de
 * l'établissement** : `POST /public/{slug}/appointments` complète un numéro
 * national avec `tenants.country_code`, et un formulaire resté sur la variante
 * sans pays refuserait dans le navigateur ce que l'API accepte. L'écart se
 * verrait à l'écran — « 06 12 34 56 78 » barré sur un salon français — et c'est
 * le défaut que le ticket referme.
 *
 * Les deux sens de l'écart sont mauvais, et c'est pourquoi les trois
 * emplacements bougent ensemble : un formulaire **plus strict** que l'API refuse
 * une réservation que le salon aurait prise ; un formulaire **plus permissif**
 * déplace le refus après la soumission, en bloc en tête de page, pour un numéro
 * que le champ venait d'accepter — ce qu'interdit la skill web-frontend §4.
 */
function contactFormSchemaFor(countryCode: string | null) {
  return guestContactSchemaFor(countryCode).extend({
    phone: z.union([z.literal(''), e164PhoneSchemaFor(countryCode)]),
    clientNote: longTextSchema,
    consent: consentSchema,
  });
}

/** La forme validée d'un formulaire de coordonnées, quel que soit le pays. */
type ContactFormValues = z.output<ReturnType<typeof contactFormSchemaFor>>;

/**
 * L'aide et l'erreur du champ « Téléphone » — **sans exemple de pays** (#626),
 * mais pas sans pays (#1028).
 *
 * Les deux disaient d'abord « +261… » et « par exemple +261 34 12 345 67 » : un
 * indicatif de Madagascar écrit en dur, donc proposé à l'identique à la cliente
 * d'un salon lyonnais dont la vitrine affiche pourtant un numéro en +33. #626 a
 * retiré l'exemple, et cette décision-là tient toujours : **aucun des deux
 * libellés ci-dessous n'écrit de numéro national**. Le seul qu'on saurait former
 * serait celui d'un plan de numérotation particulier, et « 06 12 34 56 78 »
 * montré à un salon américain décrirait une forme que rien n'y acceptera jamais
 * — c'est mot pour mot ce que motive `e164PhoneSchemaFor` côté contrat.
 *
 * Ce que #1028 change n'est pas l'exemple, c'est **ce que le champ accepte**.
 * Tant que la validation refusait tout numéro national, exiger l'indicatif était
 * la vérité à dire à la cliente. Depuis que l'établissement fournit son pays,
 * l'exiger serait devenu faux : le formulaire annoncerait une contrainte que
 * l'API n'applique plus, et une cliente française retaperait en +33 un numéro
 * que le salon aurait accepté tel quel.
 *
 * Les deux libellés suivent donc le pays, sans rien inventer de plus : avec un
 * pays, ils disent que le format du salon convient ; sans, ils disent
 * l'indicatif, qui est alors la seule forme complétable. `publicTenantSchema`
 * porte l'adresse en `.optional()`, et un salon qui n'a pas publié la sienne
 * retombe exactement sur le libellé d'avant.
 *
 * ## Ce que #1050 y change : la longueur, jamais la règle
 *
 * L'audit `d20260918-1` demande des *« aides de champ en une ligne »*. Les deux
 * libellés faisaient deux phrases, donc deux à trois lignes à 360 px sous un
 * champ facultatif — plus de hauteur que le champ lui-même. Ils disent
 * désormais la même chose d'un trait : à quoi sert le numéro, et quelle forme
 * est acceptée. Ni l'exemple retiré par #626 ni le pays introduit par #1028 ne
 * reviennent : aucun des deux n'écrit de numéro national, et c'est toujours
 * `e164PhoneSchemaFor` qui accepte ou refuse.
 */
function phoneHint(countryCode: string | null): string {
  return countryCode === null
    ? 'Facultatif, pour le rappel par SMS — au format international.'
    : 'Facultatif, pour le rappel par SMS — au format du pays de l’établissement.';
}

/**
 * Écrit ici et non repris d'`e164PhoneSchemaFor`, alors que c'est bien ce
 * schéma-là qui refuse la saisie.
 *
 * Le message du contrat cite « +261 34 12 345 67 », et il ne peut pas mieux
 * faire : il sert aussi la frontière serveur, où le libellé n'est pas fait pour
 * être lu par une cliente. **La règle reste unique** — c'est toujours le schéma
 * du contrat qui accepte ou refuse, ce formulaire n'en redit rien ; seule la
 * formulation montrée à la cliente appartient à l'écran qui la montre.
 *
 * Le message couvre toute valeur refusée sans distinguer laquelle : hors la
 * chaîne vide, qui est valable, ce champ n'a que deux façons d'échouer — une
 * saisie plus longue que `PHONE_MAX_LENGTH`, ou un numéro que le pays connu ne
 * permet pas de compléter — et les deux appellent la même correction.
 */
function phoneFormatError(countryCode: string | null): string {
  return countryCode === null
    ? 'numéro attendu au format international, indicatif du pays compris'
    : 'numéro attendu au format du pays de l’établissement, ou au format international';
}

interface ContactStepProps {
  readonly contact: ContactDraft;
  /**
   * L'établissement du tunnel — de quoi lier sa politique de données (#790).
   *
   * Descendu en propriété plutôt que lu d'un `useParams()` : cette étape est
   * déjà rendue avec tout ce qu'elle affiche, et une lecture du routeur ferait
   * dépendre un composant de saisie du contexte de navigation, que ses suites
   * unitaires devraient alors simuler pour rien.
   */
  readonly tenantSlug: string;
  /**
   * Le pays de l'établissement — ISO 3166-1 alpha-2, `null` s'il n'a pas publié
   * son adresse (#1028).
   *
   * C'est l'indicatif par défaut du téléphone, et il vient du même endroit que
   * celui du serveur : `tenants.country_code`. Descendu en propriété pour la
   * raison qui vaut déjà pour `tenantSlug` — cette étape est rendue avec tout ce
   * qu'elle affiche, et ses suites unitaires n'ont pas à simuler une lecture de
   * contexte pour exercer un champ de saisie.
   */
  readonly countryCode: string | null;
  /**
   * Ce que la barre basse rappelle de la réservation en cours (#1047).
   *
   * Un seul objet, composé par le tunnel : ce formulaire n'a rien à savoir du
   * catalogue ni du fuseau du salon pour afficher une ligne de rappel.
   */
  readonly summary: BookingSummary | null;
  /**
   * La cliente connectée chez ce salon, ou `null` (#1050).
   *
   * Elle vient du **cookie de présence** posé par #1045
   * (`lib/account-presence.ts`), lu côté serveur par la page du tunnel et
   * descendu jusqu'ici : aucune donnée de compte ne transite par l'URL, et rien
   * n'est relu du navigateur. Le cookie est `httpOnly`, porté sur `/{salon}`, et
   * ne contient **ni jeton ni identifiant** — seulement le prénom et le nom que
   * l'en-tête du salon affiche déjà. Il sert à afficher, pas à décider : l'API
   * revalide de son côté ce que la réservation lui envoie.
   *
   * `import type` et non une importation de valeur : `lib/account-presence.ts`
   * importe `next/headers`, qui n'existe pas côté navigateur. Le type ne
   * survit pas à la compilation, et ce Client Component reste compilable —
   * c'est l'arbitrage déjà écrit en tête de `compte/paths.ts`.
   */
  readonly presence: AccountPresence | null;
  /**
   * L'écran de connexion de ce salon — où mène « Déjà cliente ? » (#1050).
   *
   * Composé par la page, comme `exitHref` du tunnel : les composants ne
   * connaissent pas l'arborescence des routes, et le groupe `(booking)` tient
   * la sienne dans `salon-data.ts`.
   */
  readonly loginHref: string;
  /**
   * Verse la saisie en cours au brouillon **sans changer d'étape**.
   *
   * Le formulaire est non contrôlé (react-hook-form) : sans ce report, ce que la
   * cliente a tapé ne vit que dans le DOM, et disparaît au premier
   * rafraîchissement comme au retour vers le choix du créneau — alors que c'est
   * exactement ce que le brouillon promet de conserver
   * (`lib/booking/draft.ts`, troisième critère de #45).
   *
   * Il est appelé à la frappe, débouncé, et non au seul `focusout` : voir
   * `useDraftAutosave` (#737). L'appelant doit donc le tenir pour **fréquent**,
   * et son écriture dans `sessionStorage` pour synchrone — un masquage de page
   * n'attend pas un effet React.
   */
  readonly onSave: (contact: ContactDraft) => void;
  readonly onBack: () => void;
  readonly onSubmit: (contact: ContactDraft) => void;
}

/**
 * Saisie des coordonnées — premier critère d'acceptation de #45.
 *
 * Les messages d'erreur sont rendus **sur le champ** par `Field`, jamais en bloc
 * en haut de page (skill web-frontend §4) : un bloc oblige à retrouver
 * soi-même le champ fautif, sur un écran mobile où il est souvent hors vue.
 */
export function ContactStep({
  contact,
  tenantSlug,
  countryCode,
  summary,
  presence,
  loginHref,
  onSave,
  onBack,
  onSubmit,
}: ContactStepProps) {
  // Le schéma ne dépend que du pays, qui ne change pas d'une frappe à l'autre :
  // le reconstruire à chaque rendu recréerait un résolveur par caractère tapé.
  // Le résolveur est mémoïsé **avec** lui — le mémoïser à moitié laisserait
  // `zodResolver` rappelé à chaque frappe, c'est-à-dire précisément ce qu'on
  // évite ici.
  const resolver = useMemo(() => zodResolver(contactFormSchemaFor(countryCode)), [countryCode]);

  /**
   * Ce que le formulaire porte à l'ouverture — le brouillon, complété par
   * l'identité du compte quand elle manque (#1050).
   *
   * ## Pourquoi la complétion se fait ici, et pas dans le brouillon
   *
   * Le brouillon est ce que la **cliente** a posé : s'il portait d'office le nom
   * du compte, `hasDraftInput` — qui décide si « ✕ Quitter » demande
   * confirmation — retiendrait toute cliente connectée sur un tunnel où elle n'a
   * pourtant rien saisi. Et le prénom relu d'une session fermée entre-temps
   * survivrait dans `sessionStorage` à la déconnexion.
   *
   * Posé en valeur par défaut, il n'entre dans le brouillon qu'au premier geste
   * — une frappe, un champ quitté, la soumission —, c'est-à-dire au moment où il
   * devient la saisie de cette réservation. C'est exactement ce que le brouillon
   * est fait pour conserver (`lib/booking/draft.ts`), ni plus ni moins.
   *
   * Le brouillon l'emporte quand il porte quelque chose : la cliente qui a
   * corrigé son nom ne le voit pas revenir à celui du compte au retour du
   * créneau.
   *
   * Calculé une fois — `useMemo` sur les seules valeurs qui le composent : un
   * objet recréé à chaque rendu serait inoffensif ici, `defaultValues` n'étant
   * lu qu'au montage, mais il laisserait croire le contraire à la lecture.
   */
  const defaultValues = useMemo<ContactDraft>(() => {
    if (presence === null) {
      return contact;
    }

    return {
      ...contact,
      firstName: contact.firstName === '' ? presence.firstName : contact.firstName,
      lastName: contact.lastName === '' ? presence.lastName : contact.lastName,
    };
  }, [contact, presence]);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitted, isSubmitting },
  } = useForm<ContactDraft, unknown, ContactFormValues>({
    resolver,
    defaultValues,
    // Le message apparaît quand la cliente quitte le champ, pas à la première
    // frappe : signaler « adresse invalide » sur un `c` en cours de saisie est
    // du bruit.
    mode: 'onTouched',
  });

  /**
   * L'identité est-elle ouverte à la correction ?
   *
   * Fermée au départ pour qui est connectée — c'est tout l'objet du ticket :
   * « Réservé au nom de Alice Marchand » remplace deux champs déjà remplis.
   * Ouverte sans condition pour qui ne l'est pas : il n'y a alors rien à
   * résumer, et le formulaire est celui d'avant, à la mise en page près.
   *
   * L'état ne redescend jamais au brouillon : c'est une préférence d'affichage
   * de cet écran, pas une donnée de la réservation.
   */
  const [editingIdentity, setEditingIdentity] = useState(false);
  /**
   * Le résumé ne remplace les deux champs que s'il porte **de quoi réserver**.
   *
   * Il se lit sur `defaultValues` et non sur `presence` : ce sont les valeurs
   * que les deux champs masqués portent réellement, donc celles que la
   * soumission emportera. Les lire ailleurs ferait mentir l'encart — la cliente
   * qui a corrigé son nom en « Alix », puis est repartie changer de créneau,
   * verrait « Réservé au nom de Alice Marchand » au-dessus d'un formulaire qui
   * réserve pour Alix.
   *
   * Et le cookie de présence accepte un nom de famille vide
   * (`account-presence.ts`) là où `nameSchema` l'exige : résumer « Réservé au
   * nom de Alice » cacherait alors un champ requis derrière un encart qui
   * prétend le remplir, et la soumission échouerait sur une erreur invisible.
   * Dans ce cas — rare, mais réel — l'étape s'ouvre sur les champs, préremplis
   * de ce que le compte sait.
   */
  const identitySummarised =
    presence !== null &&
    defaultValues.firstName.trim() !== '' &&
    defaultValues.lastName.trim() !== '' &&
    !editingIdentity;
  /**
   * Le focus suit « Modifier » sur le premier champ qu'il vient d'ouvrir.
   *
   * Le bouton cliqué disparaît avec l'encart, et le focus retomberait sur
   * `<body>` : la tabulation repartirait du haut du document au moment précis
   * où la cliente vient de demander à corriger son nom (skill web-frontend §7).
   *
   * Le focus vise le **groupe** et non le champ : `register` rend une référence
   * neuve à chaque rendu, et la fusionner avec la nôtre ferait démonter puis
   * remonter la référence de `react-hook-form` à chaque frappe. Le groupe, lui,
   * est un nœud stable dont le premier `input` est le prénom.
   */
  const focusFirstNameRef = useRef(false);
  const namesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusFirstNameRef.current) {
      focusFirstNameRef.current = false;
      namesRef.current?.querySelector('input')?.focus();
    }
  }, [editingIdentity]);

  /**
   * Ce que le report enregistre : la saisie **telle qu'elle a été tapée**.
   *
   * `getValues` est stable d'un rendu à l'autre (react-hook-form), et `onSave`
   * l'est aussi côté tunnel : le crochet de report n'a donc pas à réenregistrer
   * ses écouteurs de masquage de page à chaque frappe.
   */
  const persistDraft = useCallback(() => {
    onSave(getValues());
  }, [onSave, getValues]);
  const autosave = useDraftAutosave(persistDraft);

  return (
    <form
      // L'étape porte la mise en page des étapes du tunnel : sans elle, les
      // champs s'empilaient sans interstice et chaque libellé se lisait comme
      // appartenant au champ du dessus (#624).
      className="spa-booking__step"
      noValidate
      // `input` remonte jusqu'ici : chaque frappe, dans n'importe quel champ,
      // reporte une écriture du brouillon (#737). C'est ce qui fait survivre au
      // rechargement le champ que la cliente **n'a pas quitté** — « Un mot pour
      // le salon », le dernier du formulaire et le plus long à retaper.
      //
      // Le report ne provoque aucun rendu par lui-même : il pose un
      // temporisateur, et la frappe reste aussi peu coûteuse qu'avant.
      onInput={autosave.schedule}
      // `focusout` remonte jusqu'ici : chaque champ quitté verse sa valeur au
      // brouillon **tout de suite**, sans attendre l'échéance du report. C'est le
      // même instant que la validation `onTouched`, donc aucun rendu
      // supplémentaire.
      onBlur={() => {
        // Le report en attente porterait les mêmes valeurs : le laisser courir
        // ferait une seconde écriture identique un instant plus tard.
        autosave.cancel();
        persistDraft();
      }}
      onSubmit={(event) => {
        // La saisie en attente est versée, et non abandonnée : la soumission
        // n'emporte la saisie entière vers le récapitulatif que si elle
        // **passe**. Refusée — un numéro national, une case non cochée —, elle
        // laisse la cliente sur cette étape, et `shouldFocusError` de
        // react-hook-form redonne le focus au champ fautif : celui qu'elle était
        // en train de taper n'a donc pas forcément connu de `focusout`, et le
        // report en attente est la seule copie de ses dernières lettres. Les
        // annuler les perdrait au premier rafraîchissement — le cas même de
        // #737. `flush` n'écrit que s'il y a quelque chose en attente : rien
        // n'est réécrit pour rien quand le `focusout` a déjà versé.
        autosave.flush();
        void handleSubmit(
          () => {
            // Le brouillon conserve la saisie **telle qu'elle a été tapée** : c'est
            // ce que la cliente doit retrouver si elle revient en arrière. La forme
            // normalisée est produite au moment de composer la requête.
            onSubmit(getValues());
          },
          // Un refus sur le prénom ou le nom **rouvre l'encart d'identité**
          // (#1050). Sans cela, le message serait rendu dans le groupe masqué :
          // le formulaire refuserait de partir sans que rien à l'écran dise
          // pourquoi, et `shouldFocusError` viserait un champ que `hidden` rend
          // infocalisable. Le cas n'est pas théorique — un nom trop long ou
          // porteur d'un caractère que `nameSchema` écarte peut venir du compte
          // aussi bien que du clavier.
          (invalid) => {
            if (invalid.firstName !== undefined || invalid.lastName !== undefined) {
              setEditingIdentity(true);
            }
          },
        )(event);
      }}
    >
      {/* Plus de titre d'étape ici : le `<h1>` du tunnel pose la question —
          « Comment vous joindre ? » —, et « Vos coordonnées » juste au-dessous
          la redisait en d'autres mots (#1047, BM-TUNNEL-11). */}

      {/* La porte d'entrée de la cliente qui a déjà un compte (BM-COMPTE-01,
          #1050). Elle est **en tête d'étape**, avant le premier champ : plus
          bas, elle serait lue après avoir retapé ce qu'elle évite.

          Ce n'est pas une sortie de tunnel au sens de la §3 de la skill
          web-frontend : le brouillon vit dans `sessionStorage`, qui suit
          l'onglet et non la page, et la réservation en cours est donc retrouvée
          telle quelle au retour. Le lien le dit, parce qu'une cliente qui a
          rempli la moitié d'un formulaire n'a aucune raison de le croire. */}
      {presence === null ? (
        <p className="spa-booking__signin">
          Déjà cliente ? <Link href={loginHref}>Se connecter</Link> — votre réservation en
          cours est conservée.
        </p>
      ) : null}

      {/* L'identité que le compte connaît, résumée plutôt que redemandée.

          Le `hidden` plutôt qu'un démontage : les deux champs restent dans le
          DOM, donc dans le formulaire, et `react-hook-form` n'a rien à
          réenregistrer au dépliage. `hidden` les retire de l'arbre
          d'accessibilité comme de l'ordre de tabulation — un champ requis
          invisible mais focalisable serait un piège au clavier. */}
      {identitySummarised ? (
        <div className="spa-booking__identity">
          <div className="spa-booking__identity-text">
            <p className="spa-booking__identity-label">Réservé au nom de</p>
            {/* Ce que les deux champs masqués portent, et donc ce qui sera
                réservé : le nom corrigé par la cliente l'emporte sur celui du
                compte ici comme dans le formulaire. */}
            <p className="spa-booking__identity-name">
              {defaultValues.firstName} {defaultValues.lastName}
            </p>
          </div>
          <Button
            variant="quiet"
            onClick={() => {
              focusFirstNameRef.current = true;
              setEditingIdentity(true);
            }}
          >
            Modifier
          </Button>
        </div>
      ) : null}

      {/* Prénom et nom côte à côte dès 30 rem (audit `d20260918-1`) : deux
          champs courts empilés sur toute la largeur d'un écran de bureau
          allongeaient le formulaire sans rien gagner en lisibilité. Le
          regroupement est aussi ce qui les fait apparaître et disparaître d'un
          bloc avec l'encart d'identité. */}
      <div className="spa-booking__names" hidden={identitySummarised} ref={namesRef}>
        <Field
          id="firstName"
          label="Prénom"
          autoComplete="given-name"
          required
          error={errors.firstName?.message}
          {...register('firstName')}
        />
        <Field
          id="lastName"
          label="Nom"
          autoComplete="family-name"
          required
          error={errors.lastName?.message}
          {...register('lastName')}
        />
      </div>
      <Field
        id="email"
        label="Adresse e-mail"
        type="email"
        autoComplete="email"
        required
        hint="La confirmation y sera envoyée."
        error={errors.email?.message}
        {...register('email')}
      />
      <Field
        id="phone"
        label="Téléphone"
        type="tel"
        autoComplete="tel"
        hint={phoneHint(countryCode)}
        error={errors.phone === undefined ? undefined : phoneFormatError(countryCode)}
        {...register('phone')}
      />
      {/* Le seul champ long du formulaire, donc le seul en `TextArea` (#748).
          Son contrat est `longTextSchema` — deux mille caractères — et une
          phrase d'allergie tapée à 360 px défilait dans un `<input>` d'une
          ligne : la cliente ne pouvait plus relire le début de ce qu'elle
          écrivait. Le back-office emploie déjà `TextArea` pour le même objet
          (« Note jointe au rendez-vous », `appointment-panel.tsx`) et pour cinq
          autres champs longs ; le parcours client était le seul à ne pas s'en
          servir.

          Rien d'autre ne change : `TextArea` ne déclare aucun style propre et
          porte les classes de `.spa-field`, donc le même cadre, le même anneau
          de focus, le même contraste et la même erreur sous le contrôle. Et pas
          de `rows` : les trois lignes par défaut du composant, comme les quatre
          autres champs longs du produit qui ne le précisent pas — seuls ceux
          d'un panneau contraint en hauteur y dérogent. */}
      <TextArea
        id="clientNote"
        label="Un mot pour le salon"
        hint="Allergie, préférence, retard annoncé — facultatif."
        error={errors.clientNote?.message}
        {...register('clientNote')}
      />

      {/* L'information et le consentement, juste avant le bouton qui les engage
          — la place que leur donne `wireframes.md` à l'étape 4 (#734).

          Le message n'apparaît qu'**après une soumission**, et c'est la seule
          exception au `mode: 'onTouched'` de ce formulaire. Une case non cochée
          n'est pas une saisie fautive : c'est l'état normal de qui n'a pas
          encore décidé. Reprocher son absence à la cliente parce qu'elle a
          tabulé dessus en lisant serait signaler une faute qu'elle n'a pas
          commise. Passé le premier clic sur « Vérifier ma réservation », la
          question est posée, et `reValidateMode` fait disparaître le message à
          la seconde où la case est cochée. */}
      <ConsentField
        id="consent"
        tenantSlug={tenantSlug}
        copy={BOOKING_CONSENT}
        error={isSubmitted ? errors.consent?.message : undefined}
        {...register('consent')}
      />

      {/* La correction nommée, dans le flux : elle dit ce qu'on va changer, là
          où « ← Retour » de l'en-tête ne dit que « revenir ». */}
      <div className="spa-booking__actions">
        <Button
          variant="quiet"
          onClick={() => {
            // Le retour n'est pas un abandon : la saisie part au brouillon avant
            // de quitter l'étape, faute de quoi la cliente qui vient changer
            // d'horaire retrouverait un formulaire vide.
            autosave.cancel();
            persistDraft();
            onBack();
          }}
        >
          Changer de créneau
        </Button>
      </div>

      {/* L'action primaire dans la barre basse, et le rappel avec elle (#1047).
          Le bouton reste **dans** le formulaire : c'est ce qui garde la
          soumission à la touche Entrée, et c'est la raison pour laquelle la
          barre est rendue par l'étape et non par le tunnel. */}
      <BookingActionBar summary={summary}>
        <Button type="submit" variant="accent" block loading={isSubmitting}>
          Vérifier ma réservation
        </Button>
      </BookingActionBar>
    </form>
  );
}
