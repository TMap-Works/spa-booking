'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES, passwordSchema } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
 * Tout refus de l'API est un 401 muet — jeton expiré, déjà utilisé, compte
 * désactivé —, et il n'y a qu'un conseil à donner : demander un nouveau lien.
 */

const invitationFormSchema = z
  .object({
    password: passwordSchema,
    confirmation: z.string(),
  })
  .refine((values) => values.password === values.confirmation, {
    message: 'les deux mots de passe ne correspondent pas',
    path: ['confirmation'],
  });

type InvitationFormValues = z.infer<typeof invitationFormSchema>;

const EXPIRED_LINK =
  'Ce lien d’activation n’est plus valable : il a expiré, ou il a déjà servi. Demandez un nouveau lien à la personne qui vous l’a envoyé — ou, si votre compte est déjà activé, connectez-vous.';

interface AdminInvitationFormProps {
  readonly tenantSlug: string;
  readonly token: string | null;
}

export function AdminInvitationForm({ tenantSlug, token }: AdminInvitationFormProps) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<InvitationFormValues>({
    resolver: zodResolver(invitationFormSchema),
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
        result.code === ERROR_CODES.UNAUTHORIZED ||
          result.code === ERROR_CODES.INVALID_INVITATION ||
          result.code === ERROR_CODES.INVITATION_ALREADY_ACCEPTED
          ? EXPIRED_LINK
          : result.message,
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
        Activer votre compte
      </h1>

      {token === null ? (
        <Notification tone="warning" title="Lien incomplet">
          <p>
            Ce lien ne contient pas de code d’activation. Ouvrez le lien complet reçu par message,
            sans le raccourcir.
          </p>
        </Notification>
      ) : null}

      {failure === null ? null : (
        <Notification tone="danger" title="Activation impossible">
          <p>{failure}</p>
          <p>
            <Link href={adminLoginPath(tenantSlug)}>Aller à la connexion</Link>
          </p>
        </Notification>
      )}

      <Field
        id="invitation-password"
        label="Mot de passe"
        hint="Douze caractères au minimum."
        type="password"
        autoComplete="new-password"
        required
        disabled={token === null}
        error={errors.password?.message}
        {...register('password')}
      />
      <Field
        id="invitation-confirmation"
        label="Confirmez le mot de passe"
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
        loadingLabel="Activation en cours…"
      >
        Activer mon compte
      </Button>
    </form>
  );
}
