'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  PLATFORM_PASSWORD_MIN_LENGTH,
  platformLoginRequestSchema,
  zodErrorMap,
  type Locale,
  type PlatformLoginRequest,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { useLocalizedFieldErrors } from '@/lib/field-refusal';
import { useNavigateAfterAuth } from '@/lib/use-navigate-after-auth';

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
 * Même règle pour les refus de champ, à une nuance près depuis #1376 : les
 * messages de `platformLoginRequestSchema` ne peuvent pas se traduire là où ils
 * sont écrits — `packages/shared` est lu par l'API autant que par le front, et
 * n'a pas de langue de requête. L'écran en traduit deux par champ, parce qu'il
 * dit mieux que le contrat ce qui cloche : la longueur attendue du mot de passe,
 * et la forme des six chiffres.
 *
 * L'adresse e-mail, non. Sa phrase de catalogue était mot pour mot
 * `validationPhrases('en').email` en anglais, et en divergeait en français —
 * « valide » ici, « valable » au contrat : le même champ disait deux phrases
 * selon que le refus venait du schéma ou du formulaire. C'est donc
 * `zodErrorMap(locale)`, passée au résolveur, qui répond pour lui — la même
 * carte et la même phrase que les formulaires de connexion de l'espace client
 * et du back-office (#1232).
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

/**
 * Ce qu'un champ refusé annonce — un message par champ, jamais par code de Zod.
 *
 * `null` pour les champs dont le contrat dit déjà le refus, et le dit dans les
 * deux langues : `zodErrorMap(locale)` répond pour eux, et le redire ici en
 * ferait une seconde source de la même phrase (#1376).
 */
const FIELD_ERROR_KEYS = {
  email: null,
  password: 'login.fieldErrors.password',
  totpCode: 'login.fieldErrors.totpCode',
} as const;

export function PlatformLoginForm({ expired }: { readonly expired: boolean }) {
  const t = useTranslations('platform');
  const locale = useLocale() as Locale;
  const { navigating, navigate } = useNavigateAfterAuth();
  const [failure, setFailure] = useState<FailureKey | null>(null);

  // Mémoïsé sur la langue, comme les formulaires de l'espace client : `path` et
  // `async` sont là pour le typage de `@hookform/resolvers`, qui déclare
  // `ParseParams` entier là où zod n'en lit qu'une partie.
  const resolver = useMemo(
    () =>
      zodResolver(platformLoginRequestSchema, {
        errorMap: zodErrorMap(locale),
        path: [],
        async: true,
      }),
    [locale],
  );

  const {
    register,
    handleSubmit,
    resetField,
    setError,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<PlatformLoginRequest>({
    resolver,
    defaultValues: { email: '', password: '', totpCode: '' },
    mode: 'onTouched',
  });

  /*
   * La phrase du contrat est calculée à la validation, et rien ne la recalcule :
   * le sélecteur de langue de la coquille rejoue la route sans démonter ce
   * formulaire, et « Adresse e-mail invalide. » resterait sous une étiquette
   * « Email address ». Le crochet rejoue la validation des champs **déjà**
   * fautifs, et d'eux seuls (#1354). Aucun refus n'est posé à la main sur un
   * champ ici — l'API ne dit jamais lequel des trois facteurs est faux.
   */
  useLocalizedFieldErrors({ locale, errors, trigger, setError });

  /**
   * Ce qu'affiche un champ refusé — rien s'il ne l'est pas.
   *
   * Sans clé propre, c'est la phrase que `zodErrorMap(locale)` a posée sur
   * l'erreur : elle est déjà dans la langue de ce rendu.
   */
  const fieldError = (name: keyof typeof FIELD_ERROR_KEYS): string | undefined => {
    const error = errors[name];

    if (error === undefined) {
      return undefined;
    }

    const key = FIELD_ERROR_KEYS[name];

    return key === null ? error.message : t(key, { min: PLATFORM_PASSWORD_MIN_LENGTH });
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await platformLoginAction(values);

    if (!result.ok) {
      setFailure(FAILURE_KEYS[result.code] ?? 'unexpected');
      // Un code refusé ne resservira pas : le vider épargne une seconde erreur.
      resetField('totpCode');
      return;
    }

    navigate(PLATFORM_CONSOLE_PATH);
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
        loading={isSubmitting || navigating}
        loadingLabel={t('login.submitting')}
      >
        {t('login.submit')}
      </Button>
    </form>
  );
}
