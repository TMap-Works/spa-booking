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
import { invitationTokenFromInput } from '../invitation/paths';
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
 *
 * ## L'écran sans jeton n'est plus une impasse (#1143)
 *
 * Il affichait « Lien incomplet — ouvrez le lien complet reçu par message » et
 * s'arrêtait là, sans rien offrir à qui n'a justement pas de lien cliquable :
 * une messagerie qui replie une adresse de trois cents caractères sur deux
 * lignes en fabrique un, systématiquement. La personne invitée peut désormais
 * **coller ce qu'elle a** — l'adresse entière ou le seul code qu'elle porte —,
 * et `invitationTokenFromInput` en tire le jeton.
 *
 * Il est tenu en état local et **non poussé dans l'URL** : l'y écrire
 * déposerait un secret à usage unique dans l'historique du navigateur et dans
 * le `Referer` de la requête suivante, alors qu'il n'y a rien à partager — la
 * page vient d'être ouverte à la main.
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
  /** Le jeton porté par l'adresse, `null` quand elle n'en porte pas. */
  readonly token: string | null;
}

export function AdminInvitationForm({ tenantSlug, token }: AdminInvitationFormProps) {
  const t = useTranslations('admin-auth.invitation');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  /** Ce que la personne a collé, et ce qu'on a su en tirer. */
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string | undefined>(undefined);
  const [pastedToken, setPastedToken] = useState<string | null>(null);
  /** Le jeton retenu : celui de l'adresse d'abord, celui du champ ensuite. */
  const activationToken = token ?? pastedToken;
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

  /**
   * Retient le jeton de ce qui vient d'être collé, ou dit pourquoi il n'y en a
   * pas. Le refus est posé **sur le champ** et non en bandeau — c'est cette
   * saisie-là qu'il faut reprendre (web-frontend §4).
   */
  function acceptPastedLink(): void {
    const extracted = invitationTokenFromInput(pasted);

    if (extracted === null) {
      setPastedToken(null);
      setPasteError(t('missingToken.invalid'));
      return;
    }

    setPasteError(undefined);
    setPastedToken(extracted);
  }

  const submit = handleSubmit(async (values) => {
    if (activationToken === null) {
      return;
    }
    setFailure(null);
    const result = await adminAcceptInvitationAction(tenantSlug, {
      token: activationToken,
      password: values.password,
    });

    if (!result.ok) {
      setFailure(
        SPENT_LINK_CODES.has(result.code)
          ? t('expiredLink')
          : errorMessage(result.code, locale),
      );
      // Le jeton venait du champ de collage et l'API vient de le refuser : on
      // rend le champ, sans quoi l'écran redeviendrait l'impasse que #1143
      // ferme — un code bien formé mais périmé, recopié de travers ou pris dans
      // le mauvais message n'aurait plus d'autre issue qu'un rechargement de la
      // page. Ce qui a été collé reste en place, à corriger.
      if (token === null) {
        setPastedToken(null);
      }
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

      {token !== null ? null : (
        <>
          <Notification
            title={pastedToken === null ? t('missingToken.title') : t('missingToken.acceptedTitle')}
            tone={pastedToken === null ? 'warning' : 'success'}
          >
            <p>{pastedToken === null ? t('missingToken.body') : t('missingToken.acceptedBody')}</p>
          </Notification>

          {pastedToken !== null ? null : (
            <>
              {/* Ni `type="password"` ni `autoComplete` : ce qu'on colle ici
                  n'est pas un secret à mémoriser mais une adresse qu'on doit
                  pouvoir relire pour vérifier qu'elle est entière. */}
              <Field
                autoComplete="off"
                error={pasteError}
                hint={t('missingToken.hint')}
                id="invitation-lien-colle"
                label={t('missingToken.field')}
                onChange={(event) => {
                  setPasted(event.target.value);
                  setPasteError(undefined);
                }}
                onKeyDown={(event) => {
                  // Entrée dans ce champ vaut « Continuer » et non « Activer » :
                  // la soumission du formulaire ne ferait rien tant qu'aucun
                  // jeton n'est retenu, et l'écran paraîtrait muet au geste le
                  // plus naturel après un collage.
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    acceptPastedLink();
                  }
                }}
                value={pasted}
              />
              <Button onClick={acceptPastedLink} variant="neutral">
                {t('missingToken.submit')}
              </Button>
            </>
          )}
        </>
      )}

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
        disabled={activationToken === null}
        error={errors.password?.message}
        {...register('password')}
      />
      <Field
        id="invitation-confirmation"
        label={t('confirmation')}
        type="password"
        autoComplete="new-password"
        required
        disabled={activationToken === null}
        error={errors.confirmation?.message}
        {...register('confirmation')}
      />
      <Button
        type="submit"
        variant="accent"
        block
        disabled={activationToken === null}
        loading={isSubmitting}
        loadingLabel={t('submitting')}
      >
        {t('submit')}
      </Button>
    </form>
  );
}
