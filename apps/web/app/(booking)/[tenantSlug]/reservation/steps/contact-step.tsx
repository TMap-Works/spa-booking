'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { e164PhoneSchema, guestContactSchema, longTextSchema } from '@spa/shared';
import { useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { TextArea } from '@/components/ui/textarea';
import { BOOKING_CONSENT, ConsentField, consentSchema } from '@/lib/booking/consent';
import type { ContactDraft } from '@/lib/booking/draft';

import { useDraftAutosave } from '../use-draft-autosave';

/**
 * Le schéma du formulaire **dérive** du contrat, il ne le réécrit pas.
 *
 * Les règles de fond — longueurs des noms, adresse e-mail, format E.164 du
 * téléphone — viennent de `guestContactSchema`, qui est aussi ce que la frontière
 * serveur applique. Deux ajustements, et deux seulement, tiennent à la nature
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
 */
const contactFormSchema = guestContactSchema.extend({
  phone: z.union([z.literal(''), e164PhoneSchema]),
  clientNote: longTextSchema,
  consent: consentSchema,
});

/**
 * L'aide et l'erreur du champ « Téléphone » — **sans exemple de pays** (#626).
 *
 * Les deux disaient auparavant « +261… » et « par exemple +261 34 12 345 67 » :
 * un indicatif de Madagascar écrit en dur, donc proposé à l'identique à la
 * cliente d'un salon lyonnais dont la vitrine affiche pourtant un numéro en
 * +33.
 *
 * ## Pourquoi neutre, plutôt que déduit de l'établissement
 *
 * Parce que le pays de la cliente n'est pas celui du salon, et que le contrat
 * partagé a déjà tranché exactement cette question à côté. L'en-tête de
 * `normalizeToE164` refuse de compléter un numéro national et dit pourquoi :
 * « Le compléter demanderait de connaître le pays de la personne, que rien dans
 * la requête ne dit — **ni le fuseau du salon, qui n'est pas un pays**, ni la
 * langue du navigateur. » Un exemple déduit de l'établissement ferait dire à
 * l'aide ce que la validation placée juste en dessous refuse de supposer.
 *
 * S'y ajoutent deux faits d'implémentation : `publicTenantSchema.address` est
 * `.optional()` — un salon qui n'a pas publié son adresse n'a aucun pays à
 * déduire —, et le projet n'embarque aucune base de métadonnées téléphoniques.
 * La déduction se réduirait donc à une table d'indicatifs écrits en dur doublée
 * d'un repli neutre : le même défaut, avec un aiguillage devant.
 *
 * Ce qui reste dit à la cliente est ce qui est vrai partout — un numéro
 * international porte son indicatif de pays — et c'est exactement ce que le
 * schéma vérifie.
 */
const PHONE_HINT = 'Facultatif, pour le rappel par SMS. Au format international, indicatif du pays compris.';

/**
 * Écrit ici et non repris de `e164PhoneSchema`, alors que c'est bien ce
 * schéma-là qui refuse la saisie.
 *
 * Le message du contrat se termine par « par exemple +261 34 12 345 67 », et il
 * ne peut pas mieux faire : il sert aussi la frontière serveur, où aucun
 * établissement n'est en vue. **La règle reste unique** — c'est toujours
 * `e164PhoneSchema` qui accepte ou refuse, ce formulaire n'en redit rien ; seule
 * la formulation montrée à la cliente appartient à l'écran qui la montre.
 *
 * Le message couvre toute valeur refusée sans distinguer laquelle : hors la
 * chaîne vide, qui est valable, ce champ n'a que deux façons d'échouer — une
 * saisie plus longue que `PHONE_MAX_LENGTH`, ou un numéro qui n'est pas au
 * format international — et les deux appellent la même correction.
 */
const PHONE_FORMAT_ERROR = 'numéro attendu au format international, indicatif du pays compris';

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
export function ContactStep({ contact, tenantSlug, onSave, onBack, onSubmit }: ContactStepProps) {
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitted, isSubmitting },
  } = useForm<ContactDraft, unknown, z.output<typeof contactFormSchema>>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: contact,
    // Le message apparaît quand la cliente quitte le champ, pas à la première
    // frappe : signaler « adresse invalide » sur un `c` en cours de saisie est
    // du bruit.
    mode: 'onTouched',
  });

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
        void handleSubmit(() => {
          // Le brouillon conserve la saisie **telle qu'elle a été tapée** : c'est
          // ce que la cliente doit retrouver si elle revient en arrière. La forme
          // normalisée est produite au moment de composer la requête.
          onSubmit(getValues());
        })(event);
      }}
    >
      <h2 className="spa-card__title">Vos coordonnées</h2>

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
      <Field
        id="email"
        label="Adresse e-mail"
        type="email"
        autoComplete="email"
        required
        hint="C’est là que sera envoyée la confirmation de votre rendez-vous."
        error={errors.email?.message}
        {...register('email')}
      />
      <Field
        id="phone"
        label="Téléphone"
        type="tel"
        autoComplete="tel"
        hint={PHONE_HINT}
        error={errors.phone === undefined ? undefined : PHONE_FORMAT_ERROR}
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

      {/* Groupés, comme le récapitulatif et la confirmation le font déjà : la
          colonne flex de `.spa-booking__step` étirerait sinon chaque bouton sur
          toute la largeur du panneau, et les deux passeraient l'un sous
          l'autre. */}
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
        <Button type="submit" variant="accent" loading={isSubmitting}>
          Vérifier ma réservation
        </Button>
      </div>
    </form>
  );
}
