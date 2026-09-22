'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { e164PhoneSchema, nameSchema, type SessionUser } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Notification } from '@/components/ui/notification';
import { PhoneField } from '@/components/ui/phone-field';

import { updateProfileAction } from '../actions';
import { useAccountSessionRenewal } from './use-account-session-renewal';

/**
 * Modification de ses coordonnées (#47, quatrième critère ; repris par #1053).
 *
 * ## Le formulaire est complet, la requête est partielle
 *
 * `updateProfileRequestSchema` est `.partial()` : l'API accepte qu'on n'envoie
 * qu'un champ. L'écran, lui, affiche les trois pré-remplis — c'est ce qu'une
 * cliente attend d'un « modifier mes coordonnées », et cela évite de lui faire
 * deviner lesquels sont modifiables. La conversion se fait à l'envoi :
 * `phone` vide devient `null` — la valeur par laquelle on **efface** un numéro —
 * et non la chaîne vide, que la colonne prendrait pour un numéro de zéro
 * caractère.
 *
 * ## Deux sections, et pourquoi (#1053)
 *
 * L'audit `d20260918-1` relève quatre champs empilés sans regroupement, dont un
 * grisé sans autre explication qu'une phrase d'aide. Identité et contact ne se
 * modifient ni pour les mêmes raisons ni à la même fréquence : deux `fieldset`
 * les séparent, et leur `legend` donne à chaque groupe un nom que les lecteurs
 * d'écran annoncent avec chaque champ (WCAG 1.3.1).
 *
 * ## L'adresse e-mail n'est plus un champ grisé, c'est une information
 *
 * Elle est l'identifiant de connexion et la clé d'unicité du compte dans
 * l'établissement : la changer demande une vérification de la nouvelle adresse,
 * sans quoi une faute de frappe rend le compte inatteignable. Le contrat
 * l'exclut (`updateProfileRequestSchema` ne la porte pas) et le DTO de l'API la
 * refuse.
 *
 * Un `<input readonly>` promettait pourtant une saisie : il prend le focus, il
 * porte un libellé de champ, et rien à l'œil ne le distingue d'un champ
 * désactivé par erreur. La valeur est donc écrite en **ligne d'information**,
 * avec un cadenas et la raison à côté — ce que la direction de #1053 demande, et
 * ce qui retire du formulaire un champ qui n'en était pas un.
 *
 * ## « Enregistrer » reste inactif tant que rien n'a changé
 *
 * `isDirty` de react-hook-form compare aux valeurs par défaut, c'est-à-dire au
 * profil servi. Un bouton qui accepte un envoi sans modification déclenche une
 * requête, une notification de succès et un rafraîchissement pour rien — et
 * apprend à la cliente que le succès annoncé ne veut rien dire.
 *
 * ## Le téléphone, depuis #825
 *
 * `PhoneField` émet un E.164 : `e164PhoneSchema` le valide sans pays à
 * compléter, avec la même bibliothèque que l'API. Le numéro enregistré revient
 * derrière son drapeau, au format national — et `isDirty` reste faux tant
 * qu'on n'y touche pas, le champ ne réécrivant pas la valeur qu'il reçoit.
 */
const profileFormSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  phone: z.union([z.literal(''), e164PhoneSchema]),
});

type ProfileFormValues = z.input<typeof profileFormSchema>;

interface ProfileFormProps {
  readonly tenantSlug: string;
  readonly profile: SessionUser;
}

export function ProfileForm({ tenantSlug, profile }: ProfileFormProps) {
  const router = useRouter();
  const { renewIfExpired } = useAccountSessionRenewal(tenantSlug);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<ProfileFormValues, unknown, z.output<typeof profileFormSchema>>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: {
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: profile.phone ?? '',
    },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    setSaved(false);

    const result = await updateProfileAction(tenantSlug, {
      firstName: values.firstName,
      lastName: values.lastName,
      // `null` efface, la chaîne vide n'est pas une valeur du contrat.
      phone: values.phone === '' ? null : values.phone,
    });

    if (!result.ok) {
      // Une session à renouveler part vers la route de renouvellement, qui rend
      // la main sur cette page ; le message n'aurait été qu'un cul-de-sac.
      if (!renewIfExpired(result)) {
        setFailure(result.message);
      }
      return;
    }

    setSaved(true);
    // Ce qui vient d'être enregistré devient la nouvelle référence : sans cela
    // le bouton resterait actif après un succès, et proposerait de réenregistrer
    // ce qui l'est déjà.
    reset(values);
    // L'en-tête est rendu côté serveur : sans ce rafraîchissement, le prénom
    // affiché ailleurs resterait l'ancien.
    router.refresh();
  });

  return (
    <section className="spa-account__panel" aria-labelledby="coordonnees-titre">
      <h2 className="spa-account__section-title" id="coordonnees-titre">
        Mes coordonnées
      </h2>

      {saved ? (
        <Notification tone="success" title="Coordonnées enregistrées">
          <p>Vos prochaines confirmations de rendez-vous utiliseront ces informations.</p>
        </Notification>
      ) : null}

      {failure === null ? null : (
        <Notification tone="danger" title="L’enregistrement a échoué">
          <p>{failure}</p>
        </Notification>
      )}

      <form className="spa-account__form" onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className="spa-account__fieldset">
          <legend className="spa-account__legend">Identité</legend>
          <Field
            id="profile-first-name"
            label="Prénom"
            autoComplete="given-name"
            required
            error={errors.firstName?.message}
            {...register('firstName')}
          />
          <Field
            id="profile-last-name"
            label="Nom"
            autoComplete="family-name"
            required
            error={errors.lastName?.message}
            {...register('lastName')}
          />
        </fieldset>

        <fieldset className="spa-account__fieldset">
          <legend className="spa-account__legend">Contact</legend>
          <Controller
            control={control}
            name="phone"
            render={({ field, fieldState }) => (
              <PhoneField
                id="profile-phone"
                label="Téléphone"
                hint="Laissez vide pour ne plus recevoir de rappel par SMS."
                invalid={fieldState.invalid}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                ref={field.ref}
              />
            )}
          />

          <p className="spa-account__readonly">
            <Icon name="lock" className="spa-account__readonly-icon" />
            <span>
              <span className="spa-account__readonly-label">Adresse e-mail</span>
              <span className="spa-account__readonly-value">{profile.email}</span>
              <span className="spa-account__readonly-hint">
                Votre identifiant de connexion. Contactez le salon pour en changer.
              </span>
            </span>
          </p>
        </fieldset>

        <Button
          type="submit"
          variant="accent"
          block
          disabled={!isDirty}
          loading={isSubmitting}
          loadingLabel="Enregistrement…"
        >
          Enregistrer
        </Button>
      </form>
    </section>
  );
}
