'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  platformTotpCodeSchema,
  zodErrorMap,
  type Locale,
  type PlatformTotpCode,
  type PlatformTotpEnrollment,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { useLocalizedFieldErrors } from '@/lib/field-refusal';
import { useNavigateAfterAuth } from '@/lib/use-navigate-after-auth';

import { platformVerifyCodeAction } from '../actions';
import { PLATFORM_CONSOLE_PATH } from '../paths';
import { TotpQrCode } from './totp-qr-code';

/**
 * Le second temps de la connexion de la console — le code (#1442).
 *
 * Un écran à part, et non un champ de plus sous le mot de passe : c'est la
 * conduite des connexions à deux facteurs, et c'est elle qui rend l'erreur
 * lisible — un refus ici ne peut plus porter que sur le code.
 *
 * ## L'enrôlement
 *
 * À la première connexion d'un opérateur, le premier temps rend l'URI
 * `otpauth://` et la clé : cet écran les montre en QR code, avec la clé groupée
 * par quatre pour qui ne peut pas scanner, puis demande le premier code. C'est
 * ce code qui confirme l'enrôlement côté API, et l'écran ne se remontre plus.
 *
 * ## Les deux refus
 *
 * `INVALID_PLATFORM_CREDENTIALS` dit un code faux — ou un défi que l'API a
 * refusé, ce qu'elle ne distingue pas. Le champ est vidé, l'écran reste.
 * `UNAUTHORIZED` vient de l'action : plus de défi en cookie, les cinq minutes
 * sont passées. Il n'y a plus rien à vérifier ici, et l'écran renvoie au mot de
 * passe en disant pourquoi (`onExpired`).
 */

type FailureKey = 'code' | 'throttled' | 'unavailable' | 'unexpected';

const FAILURE_KEYS: Readonly<Record<string, FailureKey>> = {
  [ERROR_CODES.INVALID_PLATFORM_CREDENTIALS]: 'code',
  [ERROR_CODES.VALIDATION_ERROR]: 'code',
  [ERROR_CODES.BAD_REQUEST]: 'code',
  [ERROR_CODES.TOO_MANY_REQUESTS]: 'throttled',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'unavailable',
};

/** La clé base32, par groupes de quatre — ce qu'on recopie sans se perdre. */
export function groupSecret(secret: string): string {
  return secret.replaceAll(/(.{4})(?=.)/g, '$1 ');
}

interface PlatformCodeFormProps {
  /** L'adresse saisie au premier temps — rappelée pour dire quel compte on ouvre. */
  readonly email: string;
  /** L'enrôlement à faire, ou `null` pour un opérateur déjà enrôlé. */
  readonly enrollment: PlatformTotpEnrollment | null;
  /** Le défi a expiré : retour au mot de passe, motif dit. */
  readonly onExpired: () => void;
  /** L'opérateur veut ressaisir son adresse. */
  readonly onRestart: () => void;
}

export function PlatformCodeForm({ email, enrollment, onExpired, onRestart }: PlatformCodeFormProps) {
  const t = useTranslations('platform');
  const locale = useLocale() as Locale;
  const { navigating, navigate } = useNavigateAfterAuth();
  const [failure, setFailure] = useState<FailureKey | null>(null);

  const resolver = useMemo(
    () =>
      zodResolver(platformTotpCodeSchema, {
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
    setFocus,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<PlatformTotpCode>({
    resolver,
    defaultValues: { totpCode: '' },
    // À la soumission, et non en quittant le champ : l'écran n'a qu'un champ,
    // et un refus posé au blur décalait « Changer de compte » sous le pointeur
    // entre l'appui et le relâché — le clic retombait à côté, et rien ne se
    // passait (recette de #1442).
    mode: 'onSubmit',
  });

  useLocalizedFieldErrors({ locale, errors, trigger, setError });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await platformVerifyCodeAction(values);

    if (!result.ok) {
      if (result.code === ERROR_CODES.UNAUTHORIZED) {
        onExpired();
        return;
      }

      setFailure(FAILURE_KEYS[result.code] ?? 'unexpected');
      // Un code refusé ne resservira pas : le vider épargne une seconde erreur.
      resetField('totpCode');
      setFocus('totpCode');
      return;
    }

    navigate(PLATFORM_CONSOLE_PATH);
  });

  const titleKey = enrollment === null ? 'login.code.title' : 'login.enroll.title';

  return (
    <form
      className="spa-admin__section spa-admin-form"
      aria-labelledby="plateforme-code-titre"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h1 className="spa-admin__section-title" id="plateforme-code-titre">
        {t(titleKey)}
      </h1>

      {enrollment === null ? (
        <p className="spa-auth-totp__lead">{t('login.code.lead', { email })}</p>
      ) : (
        <div className="spa-auth-totp">
          <p className="spa-auth-totp__lead">{t('login.enroll.lead')}</p>
          <p className="spa-auth-totp__step">{t('login.enroll.scan')}</p>
          <TotpQrCode value={enrollment.otpauthUri} label={t('login.enroll.qrLabel')} />
          <p className="spa-auth-totp__step">{t('login.enroll.manual')}</p>
          <code className="spa-auth-totp__secret">{groupSecret(enrollment.secret)}</code>
          <p className="spa-auth-totp__step">{t('login.enroll.confirm')}</p>
        </div>
      )}

      {failure === null ? null : (
        <Notification tone="danger" title={t(`login.errors.${failure}.title`)}>
          <p>{t(`login.errors.${failure}.body`)}</p>
        </Notification>
      )}

      <Field
        id="plateforme-totp"
        label={t('login.totp')}
        hint={t('login.totpHint')}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        // L'écran n'existe que pour ce champ : le focus y va d'emblée.
        autoFocus
        error={errors.totpCode?.message}
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
      <Button type="button" variant="quiet" block onClick={onRestart} disabled={isSubmitting || navigating}>
        {t('login.code.restart')}
      </Button>
    </form>
  );
}
