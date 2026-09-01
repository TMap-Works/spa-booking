'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES, phoneSchema, registerRequestSchema } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';

import { registerAction } from '../actions';
import { accountPath } from '../paths';

/**
 * Inscription cliente (#47, premier critère).
 *
 * Le schéma **dérive** du contrat, il ne le réécrit pas : `registerRequestSchema`
 * porte déjà la politique de mot de passe et les bornes de longueur, et les
 * recopier ici les ferait diverger au premier durcissement.
 *
 * La seule extension est celle qu'impose un formulaire HTML : un champ vide vaut
 * `''`, pas `undefined`. `phone` étant facultatif au contrat, l'union avec la
 * chaîne vide est ce qui évite un message d'erreur sur un champ qu'on a le droit
 * de ne pas remplir — et le `transform` la ramène à l'absence avant l'envoi.
 * Même conduite que le formulaire de coordonnées du tunnel.
 */
const registerFormSchema = registerRequestSchema.extend({
  phone: z.union([z.literal(''), phoneSchema]),
});

type RegisterFormValues = z.input<typeof registerFormSchema>;

interface RegisterFormProps {
  readonly tenantSlug: string;
}

export function RegisterForm({ tenantSlug }: RegisterFormProps) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues, unknown, z.output<typeof registerFormSchema>>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { email: '', password: '', firstName: '', lastName: '', phone: '' },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);

    const result = await registerAction(tenantSlug, {
      email: values.email,
      password: values.password,
      firstName: values.firstName,
      lastName: values.lastName,
      // Absent plutôt que vide : le contrat distingue les deux, et une chaîne
      // vide descendrait jusqu'à la colonne comme un numéro de zéro caractère.
      ...(values.phone === '' ? {} : { phone: values.phone }),
    });

    if (!result.ok) {
      setFailure(
        result.code === ERROR_CODES.EMAIL_ALREADY_REGISTERED
          ? 'Un compte existe déjà pour cette adresse dans cet établissement. Connectez-vous plutôt.'
          : result.message,
      );
      return;
    }

    router.replace(accountPath(tenantSlug));
    router.refresh();
  });

  return (
    <section className="spa-account__panel" aria-labelledby="inscription-titre">
      <h2 className="spa-account__section-title" id="inscription-titre">
        Créer mon compte
      </h2>

      {failure === null ? null : (
        <Notification tone="danger" title="Inscription refusée">
          <p>{failure}</p>
        </Notification>
      )}

      <form className="spa-account__form" onSubmit={(event) => void submit(event)} noValidate>
        <Field
          id="register-first-name"
          label="Prénom"
          autoComplete="given-name"
          required
          error={errors.firstName?.message}
          {...register('firstName')}
        />
        <Field
          id="register-last-name"
          label="Nom"
          autoComplete="family-name"
          required
          error={errors.lastName?.message}
          {...register('lastName')}
        />
        <Field
          id="register-email"
          label="Adresse e-mail"
          type="email"
          autoComplete="email"
          required
          hint="C’est aussi votre identifiant de connexion."
          error={errors.email?.message}
          {...register('email')}
        />
        <Field
          id="register-phone"
          label="Téléphone"
          type="tel"
          autoComplete="tel"
          hint="Facultatif — pour recevoir le rappel de votre rendez-vous par SMS."
          error={errors.phone?.message}
          {...register('phone')}
        />
        <Field
          id="register-password"
          label="Mot de passe"
          type="password"
          autoComplete="new-password"
          required
          hint="Douze caractères au minimum."
          error={errors.password?.message}
          {...register('password')}
        />
        <Button
          type="submit"
          variant="accent"
          block
          loading={isSubmitting}
          loadingLabel="Création du compte…"
        >
          Créer mon compte
        </Button>
      </form>

      <p className="spa-account__switch">
        Vous avez déjà un compte ?{' '}
        <Link href={accountPath(tenantSlug, '/connexion')}>Se connecter</Link>
      </p>
    </section>
  );
}
