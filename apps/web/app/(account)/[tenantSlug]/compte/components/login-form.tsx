'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES, loginRequestSchema, type LoginRequest } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';

import { loginAction } from '../actions';
import { accountPath } from '../paths';

/**
 * Connexion cliente (#47, premier critère).
 *
 * ## Le schéma vient du contrat, il n'est pas réécrit
 *
 * `loginRequestSchema` de `@spa/shared` est celui que l'API applique : la même
 * règle des deux côtés, écrite une fois (web-frontend §4). Le `tenantSlug` n'y
 * figure pas et n'a pas à y figurer — il vient de l'URL, et l'action serveur le
 * joint au corps.
 *
 * ## Ce que le formulaire ne fait pas : juger le mot de passe
 *
 * Aucune longueur minimale à la saisie. Une politique appliquée ici
 * verrouillerait les comptes antérieurs à son durcissement, et distinguerait
 * « trop court » de « faux » — c'est-à-dire dirait qu'un mot de passe court est
 * *le* mot de passe de ce compte. L'API rend un `INVALID_CREDENTIALS` indistinct,
 * et cet écran le répète tel quel.
 */
interface LoginFormProps {
  readonly tenantSlug: string;
  /** Le motif qui a renvoyé ici, s'il y en a un. */
  readonly expired: boolean;
}

export function LoginForm({ tenantSlug, expired }: LoginFormProps) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
    // Le message apparaît quand on quitte le champ, pas à la première frappe.
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await loginAction(tenantSlug, values);

    if (!result.ok) {
      setFailure(
        result.code === ERROR_CODES.INVALID_CREDENTIALS
          ? 'Adresse e-mail ou mot de passe incorrect.'
          : result.message,
      );
      return;
    }

    router.replace(accountPath(tenantSlug));
    // La page de compte est rendue côté serveur : sans ce rafraîchissement, la
    // navigation servirait le rendu fait **avant** que le cookie de session
    // n'existe, et rebondirait aussitôt sur cet écran.
    router.refresh();
  });

  return (
    <section className="spa-account__panel" aria-labelledby="connexion-titre">
      <h2 className="spa-account__section-title" id="connexion-titre">
        Se connecter
      </h2>

      {expired ? (
        <Notification tone="warning" title="Votre session a expiré">
          <p>Reconnectez-vous pour retrouver vos rendez-vous.</p>
        </Notification>
      ) : null}

      {failure === null ? null : (
        <Notification tone="danger" title="Connexion refusée">
          <p>{failure}</p>
        </Notification>
      )}

      <form className="spa-account__form" onSubmit={(event) => void submit(event)} noValidate>
        <Field
          id="login-email"
          label="Adresse e-mail"
          type="email"
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />
        <Field
          id="login-password"
          label="Mot de passe"
          type="password"
          autoComplete="current-password"
          required
          error={errors.password?.message}
          {...register('password')}
        />
        <Button
          type="submit"
          variant="accent"
          block
          loading={isSubmitting}
          loadingLabel="Connexion en cours…"
        >
          Se connecter
        </Button>
      </form>

      <p className="spa-account__switch">
        Pas encore de compte ?{' '}
        <Link href={accountPath(tenantSlug, '/inscription')}>Créer mon compte</Link>
      </p>
    </section>
  );
}
