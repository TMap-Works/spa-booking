'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  PLATFORM_PASSWORD_MIN_LENGTH,
  platformLoginRequestSchema,
  type PlatformLoginRequest,
} from '@spa/shared';
import { useTranslations } from 'next-intl';
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
 *
 * ## Les refus sont lus sur le code, jamais sur le message (#1106)
 *
 * Le message que porte un refus est écrit côté serveur — dans le contrat partagé
 * ou dans l'API —, donc en français : l'afficher tel quel rendrait un écran
 * anglais bilingue à la première erreur. La table ci-dessous traduit donc
 * **chaque code**, et le repli est un message du catalogue et non `result.message`.
 *
 * Même règle pour les refus de champ : les messages de `platformLoginRequestSchema`
 * sont des littéraux français, et ne peuvent pas se traduire là où ils sont
 * écrits — `packages/shared` est lu par l'API autant que par le front, et n'a
 * pas de langue de requête. L'écran traduit donc par champ.
 */

/** Les clés d'un couple titre + corps d'échec, telles que `t()` les accepte. */
type FailureKey = 'credentials' | 'throttled' | 'unavailable' | 'validation' | 'unexpected';

/** Ce que chaque refus de l'API devient à l'écran. */
const FAILURE_KEYS: Readonly<Record<string, FailureKey>> = {
  [ERROR_CODES.INVALID_PLATFORM_CREDENTIALS]: 'credentials',
  [ERROR_CODES.UNAUTHORIZED]: 'credentials',
  [ERROR_CODES.TOO_MANY_REQUESTS]: 'throttled',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'unavailable',
  [ERROR_CODES.VALIDATION_ERROR]: 'validation',
  [ERROR_CODES.BAD_REQUEST]: 'validation',
};

/** Ce qu'un champ refusé annonce — un message par champ, jamais par code de Zod. */
const FIELD_ERROR_KEYS = {
  email: 'login.fieldErrors.email',
  password: 'login.fieldErrors.password',
  totpCode: 'login.fieldErrors.totpCode',
} as const;

export function PlatformLoginForm({ expired }: { readonly expired: boolean }) {
  const t = useTranslations('platform');
  const router = useRouter();
  const [failure, setFailure] = useState<FailureKey | null>(null);

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

  /** Ce qu'affiche un champ refusé — rien s'il ne l'est pas. */
  const fieldError = (name: keyof typeof FIELD_ERROR_KEYS): string | undefined =>
    errors[name] === undefined
      ? undefined
      : t(FIELD_ERROR_KEYS[name], { min: PLATFORM_PASSWORD_MIN_LENGTH });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await platformLoginAction(values);

    if (!result.ok) {
      setFailure(FAILURE_KEYS[result.code] ?? 'unexpected');
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
        {t('login.title')}
      </h1>

      {expired ? (
        <Notification tone="warning" title={t('login.expired.title')}>
          <p>{t('login.expired.body')}</p>
        </Notification>
      ) : null}

      {failure === null ? null : (
        <Notification tone="danger" title={t(`login.errors.${failure}.title`)}>
          <p>{t(`login.errors.${failure}.body`)}</p>
        </Notification>
      )}

      <Field
        id="plateforme-email"
        label={t('login.email')}
        type="email"
        autoComplete="username"
        required
        error={fieldError('email')}
        {...register('email')}
      />
      <Field
        id="plateforme-password"
        label={t('login.password')}
        type="password"
        autoComplete="current-password"
        required
        error={fieldError('password')}
        {...register('password')}
      />
      <Field
        id="plateforme-totp"
        label={t('login.totp')}
        hint={t('login.totpHint')}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        error={fieldError('totpCode')}
        {...register('totpCode')}
      />
      <Button
        type="submit"
        variant="accent"
        block
        loading={isSubmitting}
        loadingLabel={t('login.submitting')}
      >
        {t('login.submit')}
      </Button>
    </form>
  );
}
