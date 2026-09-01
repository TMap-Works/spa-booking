'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { nameSchema, phoneSchema, type SessionUser } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';

import { updateProfileAction } from '../actions';
import { accountPath } from '../paths';

/**
 * Modification de ses coordonnées (#47, quatrième critère).
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
 * ## L'adresse e-mail est affichée, jamais modifiable
 *
 * Elle est l'identifiant de connexion et la clé d'unicité du compte dans
 * l'établissement : la changer demande une vérification de la nouvelle adresse,
 * sans quoi une faute de frappe rend le compte inatteignable. Le contrat l'exclut
 * (`updateProfileRequestSchema` ne la porte pas) et le DTO de l'API la refuse ;
 * ce champ est donc en lecture seule, avec la raison écrite à côté plutôt qu'une
 * absence inexpliquée.
 */
const profileFormSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  phone: z.union([z.literal(''), phoneSchema]),
});

type ProfileFormValues = z.input<typeof profileFormSchema>;

interface ProfileFormProps {
  readonly tenantSlug: string;
  readonly profile: SessionUser;
}

export function ProfileForm({ tenantSlug, profile }: ProfileFormProps) {
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
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
      setFailure(result.message);
      return;
    }

    setSaved(true);
    // L'en-tête et l'historique sont rendus côté serveur : sans ce
    // rafraîchissement, le nom affiché ailleurs resterait l'ancien.
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
        <Field
          id="profile-phone"
          label="Téléphone"
          type="tel"
          autoComplete="tel"
          hint="Laissez vide pour ne plus recevoir de rappel par SMS."
          error={errors.phone?.message}
          {...register('phone')}
        />
        <Field
          id="profile-email"
          label="Adresse e-mail"
          type="email"
          value={profile.email}
          readOnly
          hint="Votre identifiant de connexion. Contactez le salon pour en changer."
        />
        <Button
          type="submit"
          variant="accent"
          block
          loading={isSubmitting}
          loadingLabel="Enregistrement…"
        >
          Enregistrer
        </Button>
      </form>

      <p className="spa-account__switch">
        <Link href={accountPath(tenantSlug)}>Revenir à mes rendez-vous</Link>
      </p>
    </section>
  );
}
