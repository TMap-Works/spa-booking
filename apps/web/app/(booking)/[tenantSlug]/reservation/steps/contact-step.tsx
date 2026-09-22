'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { e164PhoneSchemaFor, guestContactSchemaFor, longTextSchema } from '@spa/shared';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { BookingActionBar, type BookingSummary } from '@/components/booking/summary-bar';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { PhoneField } from '@/components/ui/phone-field';
import { TextArea } from '@/components/ui/textarea';
import type { AccountPresence } from '@/lib/account-presence';
import { BOOKING_CONSENT, ConsentField, consentSchema } from '@/lib/booking/consent';
import type { ContactDraft } from '@/lib/booking/draft';
import { formatPhoneForDisplay } from '@/lib/phone';

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
 * L'aide du champ « Téléphone » — à quoi sert le numéro, et rien de plus.
 *
 * Elle disait jusqu'ici **quelle forme** était acceptée (« au format du pays de
 * l'établissement », « au format international »), parce que rien d'autre à
 * l'écran ne le disait. Depuis #825, le champ le montre lui-même : un drapeau,
 * l'indicatif, et un exemple du pays choisi en guise d'indication — celui que
 * #626 avait dû retirer tant qu'il était écrit en dur pour Madagascar. Le redire
 * sous le champ ajouterait une ligne à 360 px pour une information déjà
 * visible (audit `d20260918-1`, « aides de champ en une ligne »).
 *
 * Le message d'erreur n'est plus composé ici non plus : c'est `PhoneField` qui
 * le rend, parce qu'il nomme le pays du drapeau, que seul le champ connaît. La
 * règle reste celle du contrat — `e164PhoneSchemaFor`, dans le schéma
 * ci-dessus.
 */
const PHONE_HINT = 'Facultatif, pour le rappel par SMS.';

/**
 * L'adresse coupée juste après l'arobase, pour y poser un `<wbr />` (#1086).
 *
 * Une adresse ne porte ni espace ni césure : le navigateur n'a aucun endroit où
 * la rompre, et une adresse un peu longue déborde la colonne d'un téléphone
 * plutôt que de passer à la ligne. L'arobase est le point de coupure d'usage —
 * `alice@` / `example.test` —, et le seul qui laisse l'adresse lisible des deux
 * côtés.
 *
 * Rendue en deux morceaux plutôt qu'en une chaîne : `<wbr>` est un élément, pas
 * un caractère. C'est ce qui lui permet de n'apparaître ni dans une copie, ni
 * dans une recherche de page, ni dans ce qu'annonce un lecteur d'écran.
 *
 * Sans arobase — une valeur que `parsePresence` n'aurait pas dû laisser passer,
 * ou une adresse que la cliente vient de corriger à la main —, la chaîne reste
 * entière et le second morceau est vide : la ligne s'affiche telle quelle.
 */
function emailBreakParts(email: string): readonly [string, string] {
  const at = email.indexOf('@');

  return at === -1 ? [email, ''] : [email.slice(0, at + 1), email.slice(at + 1)];
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
   * La cliente connectée chez ce salon, ou `null` (#1050, élargi par #1086).
   *
   * Elle vient du **cookie de présence** posé par #1045
   * (`lib/account-presence.ts`), lu côté serveur par la page du tunnel et
   * descendu jusqu'ici : aucune donnée de compte ne transite par l'URL, et rien
   * n'est relu du navigateur. Le cookie est `httpOnly`, porté sur `/{salon}`, et
   * ne contient **ni jeton ni identifiant** — seulement les coordonnées que
   * cette étape demande, et que l'en-tête du salon affiche déjà pour partie. Il
   * sert à afficher, pas à décider : l'API revalide de son côté ce que la
   * réservation lui envoie.
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
   * Ce que le formulaire porte à l'ouverture — le brouillon, complété par les
   * coordonnées du compte quand elles manquent (#1050, #1086).
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
   * ## Les quatre champs depuis #1086, et non plus deux
   *
   * Le cookie ne portait que le prénom et le nom, et l'adresse e-mail restait à
   * saisir — le premier critère de #1050, *« connectée, l'étape se valide sans
   * rien saisir »*, tombait sur ce champ-là, qui est requis. Le cookie porte
   * désormais les quatre, et le même arbitrage vaut pour chacun : le compte ne
   * complète que ce que le brouillon laisse vide.
   *
   * Le téléphone y compris, bien qu'il soit facultatif : c'est le canal du
   * rappel J-1 par SMS (CDC §1.4), et le laisser vide alors que le compte le
   * connaît reviendrait à faire perdre ce rappel à qui ne prend pas la peine de
   * le retaper.
   *
   * Calculé une fois — `useMemo` sur les seules valeurs qui le composent : un
   * objet recréé à chaque rendu serait inoffensif ici, `defaultValues` n'étant
   * lu qu'au montage, mais il laisserait croire le contraire à la lecture.
   */
  const defaultValues = useMemo<ContactDraft>(() => {
    if (presence === null) {
      return contact;
    }

    // Le brouillon n'a jamais rien reçu de cette étape : le `''` d'un champ
    // facultatif y est une absence, pas un choix. Dès la première écriture —
    // un `focusout`, un report de frappe —, il porte les quatre valeurs, celles
    // du compte comprises : un `''` qui subsiste après cela est une suppression
    // délibérée. Voir le téléphone ci-dessous.
    const untouched =
      contact.firstName === '' &&
      contact.lastName === '' &&
      contact.email === '' &&
      contact.phone === '';

    return {
      ...contact,
      firstName: contact.firstName === '' ? presence.firstName : contact.firstName,
      lastName: contact.lastName === '' ? presence.lastName : contact.lastName,
      email: contact.email === '' ? presence.email : contact.email,
      // Le téléphone est le seul des quatre dont la chaîne vide est une valeur
      // **valable** : `contactFormSchemaFor` l'accepte telle quelle. Le compléter
      // comme les trois autres reviendrait à rendre son numéro à la cliente qui
      // vient de l'effacer — et, pire, à le replier derrière « Modifier »,
      // `phoneSummarised` redevenant vrai. Elle repartirait au récapitulatif
      // avec le rappel SMS qu'elle venait de refuser, sans qu'un champ à l'écran
      // le dise. Les trois autres sont requis : leur `''` n'est jamais un choix,
      // et la complétion y reste inconditionnelle.
      phone: untouched ? presence.phone : contact.phone,
    };
  }, [contact, presence]);

  const {
    register,
    control,
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
   * Les coordonnées du compte sont-elles ouvertes à la correction ?
   *
   * Fermées au départ pour qui est connectée — c'est tout l'objet du ticket :
   * « Réservé au nom de Alice Marchand · alice@… · +33 6… » remplace quatre
   * champs déjà remplis. Ouvertes sans condition pour qui ne l'est pas : il n'y
   * a alors rien à résumer, et le formulaire est celui d'avant, à la mise en
   * page près.
   *
   * L'état ne redescend jamais au brouillon : c'est une préférence d'affichage
   * de cet écran, pas une donnée de la réservation.
   */
  const [editingIdentity, setEditingIdentity] = useState(false);
  /**
   * Le résumé ne remplace les champs que s'il porte **de quoi réserver**.
   *
   * Il se lit sur `defaultValues` et non sur `presence` : ce sont les valeurs
   * que les champs masqués portent réellement, donc celles que la soumission
   * emportera. Les lire ailleurs ferait mentir l'encart — la cliente qui a
   * corrigé son nom en « Alix », puis est repartie changer de créneau, verrait
   * « Réservé au nom de Alice Marchand » au-dessus d'un formulaire qui réserve
   * pour Alix.
   *
   * Les trois champs **requis** conditionnent le résumé, et pour la même raison.
   * Le cookie de présence accepte un nom de famille vide, et depuis #1086 une
   * adresse vide — celle d'un cookie posé avant ce ticket-ci
   * (`account-presence.ts`) — là où `nameSchema` et `emailSchema` les exigent :
   * résumer « Réservé au nom de Alice » cacherait alors un champ requis derrière
   * un encart qui prétend le remplir, et la soumission échouerait sur une erreur
   * invisible. Dans ces cas — rares, mais réels — l'étape s'ouvre sur les
   * champs, préremplis de ce que le compte sait.
   */
  const identitySummarised =
    presence !== null &&
    defaultValues.firstName.trim() !== '' &&
    defaultValues.lastName.trim() !== '' &&
    defaultValues.email.trim() !== '' &&
    !editingIdentity;
  /**
   * Le téléphone, lui, ne se replie que s'il est **prérempli**.
   *
   * L'audit `d20260918-1` écrit « déplie les champs pré-remplis » : ce qui se
   * replie est ce que l'encart résume, et un champ vide ne se résume pas. Le
   * replier tout de même pour un compte sans numéro — `sessionUserSchema` le
   * porte à `null`, c'est le cas courant — cacherait derrière « Modifier » le
   * seul choix qui reste à faire à la cliente connectée, alors que c'est celui
   * qui lui vaut le rappel par SMS. Il reste donc ouvert, sous l'encart, avec
   * son aide qui dit à quoi il sert (BM-TUNNEL-03).
   */
  const phoneSummarised = identitySummarised && defaultValues.phone.trim() !== '';
  /** Les deux moitiés de l'adresse résumée — voir `emailBreakParts`. */
  const [emailLocalPart, emailDomainPart] = emailBreakParts(defaultValues.email);
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
          // Un refus sur l'un des champs repliés **rouvre l'encart** (#1050,
          // étendu à l'adresse et au téléphone par #1086). Sans cela, le message
          // serait rendu dans un groupe masqué : le formulaire refuserait de
          // partir sans que rien à l'écran dise pourquoi, et `shouldFocusError`
          // viserait un champ que `hidden` rend infocalisable. Le cas n'est pas
          // théorique — un nom trop long, ou un numéro que le pays de
          // l'établissement ne permet pas de compléter, peut venir du compte
          // aussi bien que du clavier.
          (invalid) => {
            if (
              invalid.firstName !== undefined ||
              invalid.lastName !== undefined ||
              invalid.email !== undefined ||
              invalid.phone !== undefined
            ) {
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

      {/* Les coordonnées que le compte connaît, résumées plutôt que redemandées.

          Le `hidden` plutôt qu'un démontage : les champs restent dans le
          DOM, donc dans le formulaire, et `react-hook-form` n'a rien à
          réenregistrer au dépliage. `hidden` les retire de l'arbre
          d'accessibilité comme de l'ordre de tabulation — un champ requis
          invisible mais focalisable serait un piège au clavier. */}
      {identitySummarised ? (
        <div className="spa-booking__identity">
          <div className="spa-booking__identity-text">
            <p className="spa-booking__identity-label">Réservé au nom de</p>
            {/* Ce que les champs masqués portent, et donc ce qui sera
                réservé : le nom corrigé par la cliente l'emporte sur celui du
                compte ici comme dans le formulaire. */}
            <p className="spa-booking__identity-name">
              {defaultValues.firstName} {defaultValues.lastName}
            </p>
            {/* L'adresse, et le numéro s'il y en a un — la ligne que l'audit
                `d20260918-1` dessine sous le nom (#1086). Elle n'est pas
                décorative : c'est là que part la confirmation, et une cliente
                qui ne voit pas à quelle adresse ne peut pas corriger celle d'un
                compte ouvert il y a deux ans.

                `<wbr />` avant le domaine, et c'est le seul artifice de cette
                ligne : une adresse n'a ni espace ni césure, et
                `marie-christine.andriamanantena@spa-lumiere.test` déborderait
                la colonne de 360 px — la feuille de styles du tunnel appartient
                à d'autres écrans que celui-ci, et le point de coupure se pose
                aussi bien dans le balisage, qui est l'endroit prévu pour lui.
                Le texte reste d'un seul tenant pour la copie comme pour un
                lecteur d'écran : `<wbr>` n'insère aucun caractère. */}
            <p className="spa-booking__identity-label">
              {emailLocalPart}
              <wbr />
              {emailDomainPart}
              {phoneSummarised ? ` · ${formatPhoneForDisplay(defaultValues.phone)}` : null}
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
      {/* L'adresse et le numéro se replient avec les noms quand l'encart les
          résume (#1086) — « déplie les champs pré-remplis », audit
          `d20260918-1`. Le `hidden` est porté par une enveloppe et non par le
          champ : `Field` reverse ses propriétés restantes à l'`<input>`, et un
          `hidden` posé là masquerait la saisie en laissant son libellé, son
          aide et son message d'erreur à l'écran.

          Une enveloppe nue plutôt qu'une classe : elle ne déclare aucun
          `display`, donc la règle `[hidden] { display: none }` du navigateur
          s'y applique sans contre-mesure — c'est ce que `.spa-booking__names`
          doit rattraper en CSS pour sa grille —, et elle reste un enfant direct
          de `.spa-booking__step`, dont le `gap` fait le rythme. */}
      <div hidden={identitySummarised}>
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
      </div>
      <div hidden={phoneSummarised}>
        {/* Contrôlé et non enregistré : le champ émet un E.164 (#825), là où
            `register` lirait ce qu'affiche l'`<input>` — « 06 12 34 56 78 ».
            Le brouillon garde donc la forme normalisée, et la relit derrière
            le bon drapeau au retour. */}
        <Controller
          control={control}
          name="phone"
          render={({ field, fieldState }) => (
            <PhoneField
              id="phone"
              label="Téléphone"
              defaultCountry={countryCode}
              hint={PHONE_HINT}
              invalid={fieldState.invalid}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={field.ref}
            />
          )}
        />
      </div>
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
