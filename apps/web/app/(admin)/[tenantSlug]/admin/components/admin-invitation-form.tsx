'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  errorMessage,
  passwordSchema,
  zodErrorMap,
  type Locale,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';

import { adminAcceptInvitationAction } from '../actions';
import { adminLoginPath } from '../paths';
import { adminLandingPath } from './navigation';

/**
 * Le choix du premier mot de passe d'un compte invité.
 *
 * La confirmation n'existe que côté écran : l'API ne reçoit que le mot de passe
 * et le jeton (`acceptInvitationRequestSchema`).
 *
 * Trois codes disent la même chose — jeton expiré, déjà utilisé, compte
 * désactivé —, et il n'y a qu'un conseil à donner : demander un nouveau lien.
 *
 * ## Les mots viennent du catalogue `admin-auth` (#853)
 *
 * Y compris le refus du schéma : le message de `.refine` est un texte affiché
 * sous un champ, et le laisser au module l'aurait figé dans une langue. Le
 * schéma est donc **construit avec sa phrase**, et mémoïsé sur elle — un schéma
 * neuf à chaque frappe ferait reconstruire le résolveur de `react-hook-form`.
 *
 * Tout autre refus vient de `errorMessage(code, locale)` du contrat partagé et
 * non du `message` de l'API, qui n'est pas traduit (voir `admin-login-form.tsx`).
 */

function invitationFormSchema(mismatch: string) {
  return z
    .object({
      password: passwordSchema,
      confirmation: z.string(),
    })
    .refine((values) => values.password === values.confirmation, {
      message: mismatch,
      path: ['confirmation'],
    });
}

type InvitationFormValues = z.infer<ReturnType<typeof invitationFormSchema>>;

/** Les refus qui disent tous « ce lien ne vaut plus » — voir l'en-tête. */
const SPENT_LINK_CODES: ReadonlySet<string> = new Set<string>([
  ERROR_CODES.UNAUTHORIZED,
  ERROR_CODES.INVALID_INVITATION,
  ERROR_CODES.INVITATION_ALREADY_ACCEPTED,
]);

interface AdminInvitationFormProps {
  readonly tenantSlug: string;
  readonly token: string | null;
}

export function AdminInvitationForm({ tenantSlug, token }: AdminInvitationFormProps) {
  const t = useTranslations('admin-auth.invitation');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  // Les bornes de `passwordSchema` sont dites par `zodErrorMap` — « au moins 12
  // caractères » dans la langue de l'écran, et non en anglais brut de zod (#845).
  // `path` et `async` ne sont là que pour le typage de `@hookform/resolvers` :
  // zod les recalcule (`safeParseAsync`).
  const resolver = useMemo(
    () =>
      zodResolver(invitationFormSchema(t('mismatch')), {
        errorMap: zodErrorMap(locale),
        path: [],
        async: true,
      }),
    [locale, t],
  );

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<InvitationFormValues>({
    resolver,
    defaultValues: { password: '', confirmation: '' },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    if (token === null) {
      return;
    }
    setFailure(null);
    const result = await adminAcceptInvitationAction(tenantSlug, {
      token,
      password: values.password,
    });

    if (!result.ok) {
      setFailure(
        SPENT_LINK_CODES.has(result.code)
          ? t('expiredLink')
          : errorMessage(result.code, locale),
      );
      return;
    }

    router.replace(adminLandingPath(tenantSlug, result.data.role) ?? adminLoginPath(tenantSlug));
    router.refresh();
  });

  return (
    <form
      className="spa-admin__section spa-admin-form"
      aria-labelledby="admin-invitation-titre"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h1 className="spa-admin__section-title" id="admin-invitation-titre">
        {t('title')}
      </h1>

      {token === null ? (
        <Notification tone="warning" title={t('missingToken.title')}>
          <p>{t('missingToken.body')}</p>
        </Notification>
      ) : null}

      {failure === null ? null : (
        <Notification tone="danger" title={t('failureTitle')}>
          <p>{failure}</p>
          <p>
            <Link href={adminLoginPath(tenantSlug)}>{t('goToLogin')}</Link>
          </p>
        </Notification>
      )}

      <Field
        id="invitation-password"
        label={t('password')}
        hint={t('passwordHint')}
        type="password"
        autoComplete="new-password"
        required
        disabled={token === null}
        error={errors.password?.message}
        {...register('password')}
      />
      <Field
        id="invitation-confirmation"
        label={t('confirmation')}
        type="password"
        autoComplete="new-password"
        required
        disabled={token === null}
        error={errors.confirmation?.message}
        {...register('confirmation')}
      />
      <Button
        type="submit"
        variant="accent"
        block
        disabled={token === null}
        loading={isSubmitting}
        loadingLabel={t('submitting')}
      >
        {t('submit')}
      </Button>
    </form>
  );
}
