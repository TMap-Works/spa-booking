'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { e164PhoneSchema, guestContactSchema, longTextSchema } from '@spa/shared';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import type { ContactDraft } from '@/lib/booking/draft';

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
 */
const contactFormSchema = guestContactSchema.extend({
  phone: z.union([z.literal(''), e164PhoneSchema]),
  clientNote: longTextSchema,
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
   * Verse la saisie en cours au brouillon **sans changer d'étape**.
   *
   * Le formulaire est non contrôlé (react-hook-form) : sans ce report, ce que la
   * cliente a tapé ne vit que dans le DOM, et disparaît au premier
   * rafraîchissement comme au retour vers le choix du créneau — alors que c'est
   * exactement ce que le brouillon promet de conserver
   * (`lib/booking/draft.ts`, troisième critère de #45).
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
export function ContactStep({ contact, onSave, onBack, onSubmit }: ContactStepProps) {
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ContactDraft, unknown, z.output<typeof contactFormSchema>>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: contact,
    // Le message apparaît quand la cliente quitte le champ, pas à la première
    // frappe : signaler « adresse invalide » sur un `c` en cours de saisie est
    // du bruit.
    mode: 'onTouched',
  });

  return (
    <form
      noValidate
      // `focusout` remonte jusqu'ici : chaque champ quitté verse sa valeur au
      // brouillon. C'est le même instant que la validation `onTouched`, donc
      // aucun rendu supplémentaire, et cela suffit à faire survivre la saisie à
      // un rafraîchissement.
      onBlur={() => {
        onSave(getValues());
      }}
      onSubmit={(event) => {
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
      <Field
        id="clientNote"
        label="Un mot pour le salon"
        hint="Allergie, préférence, retard annoncé — facultatif."
        error={errors.clientNote?.message}
        {...register('clientNote')}
      />

      <Button
        variant="quiet"
        onClick={() => {
          // Le retour n'est pas un abandon : la saisie part au brouillon avant
          // de quitter l'étape, faute de quoi la cliente qui vient changer
          // d'horaire retrouverait un formulaire vide.
          onSave(getValues());
          onBack();
        }}
      >
        Changer de créneau
      </Button>
      <Button type="submit" variant="accent" loading={isSubmitting}>
        Vérifier ma réservation
      </Button>
    </form>
  );
}
