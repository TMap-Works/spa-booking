'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES, platformLoginRequestSchema, type PlatformLoginRequest } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';

import { platformLoginAction } from '../actions';
import { PLATFORM_CONSOLE_PATH } from '../paths';

/**
 * Le formulaire de connexion de la console.
 *
 * Le refus ne dit jamais lequel des trois facteurs est faux — l'API ne le dit
 * pas non plus (`INVALID_PLATFORM_CREDENTIALS`). Le seul conseil utile est donc
 * celui du code, le facteur qui expire toutes les trente secondes.
 */

const FAILURE_COPY: ReadonlyMap<string, { title: string; message: string }> = new Map([
  [
    ERROR_CODES.INVALID_PLATFORM_CREDENTIALS,
    {
      title: 'Connexion refusée',
      message:
        'Adresse, mot de passe ou code incorrect. Si le code venait d’expirer, saisissez le suivant.',
    },
  ],
  [
    ERROR_CODES.TOO_MANY_REQUESTS,
    {
      title: 'Trop de tentatives',
      message: 'Patientez une minute avant de réessayer.',
    },
  ],
  [
    ERROR_CODES.SERVICE_UNAVAILABLE,
    {
      title: 'Service indisponible',
      message: 'Le service est momentanément injoignable. Merci de réessayer dans un instant.',
    },
  ],
]);

export function PlatformLoginForm({ expired }: { readonly expired: boolean }) {
  const router = useRouter();
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null);

  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<PlatformLoginRequest>({
    resolver: zodResolver(platformLoginRequestSchema),
    defaultValues: { email: '', password: '', totpCode: '' },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await platformLoginAction(values);

    if (!result.ok) {
      setFailure(
        FAILURE_COPY.get(result.code) ?? { title: 'Connexion impossible', message: result.message },
      );
      // Un code refusé ne resservira pas : le vider épargne une seconde erreur.
      resetField('totpCode');
      return;
    }

    router.replace(PLATFORM_CONSOLE_PATH);
    router.refresh();
  });

  return (
    <form
      className="spa-admin__section spa-admin-form"
      aria-labelledby="plateforme-connexion-titre"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h1 className="spa-admin__section-title" id="plateforme-connexion-titre">
        Console plateforme — se connecter
      </h1>

      {expired ? (
        <Notification tone="warning" title="Votre session a expiré">
          <p>Une session de console dure trente minutes. Reconnectez-vous avec un nouveau code.</p>
        </Notification>
      ) : null}

      {failure === null ? null : (
        <Notification tone="danger" title={failure.title}>
          <p>{failure.message}</p>
        </Notification>
      )}

      <Field
        id="plateforme-email"
        label="Adresse e-mail"
        type="email"
        autoComplete="username"
        required
        error={errors.email?.message}
        {...register('email')}
      />
      <Field
        id="plateforme-password"
        label="Mot de passe"
        type="password"
        autoComplete="current-password"
        required
        error={errors.password?.message}
        {...register('password')}
      />
      <Field
        id="plateforme-totp"
        label="Code de vérification"
        hint="Les six chiffres affichés par votre application d’authentification."
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        error={errors.totpCode?.message}
        {...register('totpCode')}
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
  );
}
