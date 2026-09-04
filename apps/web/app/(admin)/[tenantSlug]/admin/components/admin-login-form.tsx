'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES, loginRequestSchema, type LoginRequest } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';

import { adminLoginAction } from '../actions';
import { adminSettingsPath } from '../paths';

/**
 * Connexion au back-office.
 *
 * ## Le schéma vient du contrat, il n'est pas réécrit
 *
 * `loginRequestSchema` de `@spa/shared` est celui que l'API applique : la même
 * règle des deux côtés, écrite une fois (web-frontend §4). Le `tenantSlug` n'y
 * figure pas et n'a pas à y figurer — il vient de l'URL, et l'action serveur le
 * joint au corps.
 *
 * ## Ce que cet écran ne juge pas : le rôle
 *
 * Il ouvre une session pour toute identité valide de l'établissement, y compris
 * une cliente. C'est l'API qui refuse ensuite les écrans de réglages en 403 : la
 * décision d'autorisation appartient au seul endroit qui ne peut pas être
 * contourné, et la dupliquer ici la ferait diverger au premier changement de
 * seuil. L'écran de réglages traduit ce 403 en message lisible.
 */
export function AdminLoginForm({ tenantSlug }: { readonly tenantSlug: string }) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: '', password: '' },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await adminLoginAction(tenantSlug, values);

    if (!result.ok) {
      setFailure(
        result.code === ERROR_CODES.INVALID_CREDENTIALS
          ? 'Adresse e-mail ou mot de passe incorrect.'
          : result.message,
      );
      return;
    }

    router.replace(adminSettingsPath(tenantSlug));
    // Les pages du back-office sont rendues côté serveur : sans ce
    // rafraîchissement, la navigation servirait le rendu fait **avant** que le
    // cookie de session n'existe, et rebondirait aussitôt sur cet écran.
    router.refresh();
  });

  return (
    <section className="spa-admin__section" aria-labelledby="admin-connexion-titre">
      <h1 className="spa-admin__section-title" id="admin-connexion-titre">
        Back-office — se connecter
      </h1>

      {failure === null ? null : (
        <Notification tone="danger" title="Connexion refusée">
          <p>{failure}</p>
        </Notification>
      )}

      <form onSubmit={(event) => void submit(event)} noValidate>
        <Field
          id="admin-login-email"
          label="Adresse e-mail"
          type="email"
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />
        <Field
          id="admin-login-password"
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
    </section>
  );
}
