'use client';

import {
  ERROR_CODES,
  PLATFORM_NOTE_MAX_LENGTH,
  PLATFORM_STATUS_REASON_MIN_LENGTH,
  PLATFORM_STATUS_REASON_MAX_LENGTH,
  type TenantAccessLinks,
} from '@spa/shared';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { TextArea } from '@/components/ui/textarea';

import {
  addTenantNoteAction,
  reissueTenantInvitationAction,
  updateTenantStatusAction,
  type PlatformActionResult,
} from '../actions';
import { PLATFORM_SESSION_END_PATH } from '../session/fin/path';
import { AccessLinks } from './access-links';

/**
 * Les gestes de la fiche d'un salon — renvoyer les liens d'accès, suspendre ou
 * réactiver, noter un échange.
 *
 * Chacun passe par une action serveur, et chacun laisse une ligne dans
 * l'historique : la fiche se relit après coup (`router.refresh()`), plutôt que
 * d'insérer d'elle-même une ligne que la base n'aurait pas confirmée.
 *
 * ## Les refus sont lus sur le code (#1106)
 *
 * Les messages que portent les refus — ceux du contrat partagé comme ceux de
 * l'API — sont écrits en français côté serveur. Chaque panneau traduit donc le
 * **code**, avec un message qui dit ce que *ce* geste a refusé : un
 * `VALIDATION_ERROR` sur la suspension parle du motif manquant, le même code sur
 * une note parle de la note.
 */

type GenericErrorKey = 'tooManyRequests' | 'unavailable' | 'unexpected';

/** Les refus qui ne dépendent pas du geste, et ce qu'ils disent. */
const GENERIC_ERROR_KEYS: Readonly<Record<string, GenericErrorKey>> = {
  [ERROR_CODES.TOO_MANY_REQUESTS]: 'tooManyRequests',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'unavailable',
};

/**
 * Une session expirée renvoie à la connexion ; tout autre refus rend la clé de
 * ce qu'il faut afficher.
 *
 * `null` couvre les deux cas où l'écran n'a rien à dire : le geste a réussi, ou
 * la navigation est déjà partie vers la connexion.
 */
function useRefusal(): (result: PlatformActionResult<unknown>) => GenericErrorKey | null {
  const router = useRouter();

  return (result) => {
    if (result.ok) {
      return null;
    }
    if (result.code === ERROR_CODES.UNAUTHORIZED) {
      router.replace(PLATFORM_SESSION_END_PATH);
      return null;
    }
    return GENERIC_ERROR_KEYS[result.code] ?? 'unexpected';
  };
}

/**
 * Renvoie les liens d'accès du gérant — une nouvelle invitation, que
 * l'historique garde.
 */
export function TenantAccessPanel({ tenantId }: { readonly tenantId: string }) {
  const t = useTranslations('platform');
  const router = useRouter();
  const refusal = useRefusal();
  const [pending, setPending] = useState(false);
  const [links, setLinks] = useState<{ links: TenantAccessLinks; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reissue = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const result = await reissueTenantInvitationAction(tenantId);
      if (result.ok) {
        setLinks({ links: result.data.links, email: result.data.admin.email });
        router.refresh();
        return;
      }
      if (result.code === ERROR_CODES.TENANT_ADMIN_MISSING) {
        setError(t('actions.noAdmin'));
        return;
      }
      const key = refusal(result);
      setError(key === null ? null : t(`errors.${key}`));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="spa-console-record__stack">
      <p className="spa-admin-toolbar__hint">{t('actions.accessHint')}</p>
      <Button
        loading={pending}
        loadingLabel={t('actions.accessPending')}
        onClick={() => void reissue()}
        variant="neutral"
      >
        {links === null ? t('actions.accessSend') : t('actions.accessAgain')}
      </Button>
      {error === null ? null : (
        <Notification tone="danger" title={t('actions.linksUnavailable')}>
          <p>{error}</p>
        </Notification>
      )}
      {links === null ? null : (
        <>
          <p className="spa-admin-toolbar__hint">
            {t('actions.accessIssued', { email: links.email })}
          </p>
          <AccessLinks idPrefix={`fiche-${tenantId}`} links={links.links} />
        </>
      )}
    </div>
  );
}

/**
 * Suspendre ou réactiver le salon — motif exigé, confirmé par un second clic.
 *
 * La suspension est un geste lourd : la vitrine et la connexion répondent
 * « introuvable », les sessions ouvertes sont coupées. Le formulaire ne s'ouvre
 * donc qu'à la demande, et dit ce qui va se passer avant qu'on confirme.
 */
export function TenantStatusPanel({
  tenantId,
  isActive,
}: {
  readonly tenantId: string;
  readonly isActive: boolean;
}) {
  const t = useTranslations('platform');
  const router = useRouter();
  const refusal = useRefusal();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (reason.trim().length < PLATFORM_STATUS_REASON_MIN_LENGTH) {
      setError(t('actions.reasonRequired'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await updateTenantStatusAction(tenantId, {
        isActive: !isActive,
        reason: reason.trim(),
      });
      if (result.ok) {
        setOpen(false);
        setReason('');
        router.refresh();
        return;
      }
      if (result.code === ERROR_CODES.VALIDATION_ERROR) {
        setError(t('actions.reasonRequired'));
        return;
      }
      const key = refusal(result);
      setError(key === null ? null : t(`errors.${key}`));
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <div className="spa-console-record__stack">
        <p className="spa-admin-toolbar__hint">
          {isActive ? t('actions.suspendHint') : t('actions.suspendedHint')}
        </p>
        <Button
          onClick={() => {
            setOpen(true);
          }}
          variant={isActive ? 'danger' : 'accent'}
        >
          {isActive ? t('actions.suspend') : t('actions.reactivate')}
        </Button>
      </div>
    );
  }

  return (
    <form className="spa-console-record__stack" noValidate onSubmit={(event) => void submit(event)}>
      <TextArea
        error={error ?? undefined}
        hint={t('actions.reasonHint')}
        id={`statut-motif-${tenantId}`}
        label={isActive ? t('actions.suspendReason') : t('actions.reactivateReason')}
        maxLength={PLATFORM_STATUS_REASON_MAX_LENGTH}
        onChange={(event) => {
          setReason(event.target.value);
        }}
        required
        rows={3}
        value={reason}
      />
      <div className="spa-console-record__buttons">
        <Button
          loading={pending}
          loadingLabel={isActive ? t('actions.suspending') : t('actions.reactivating')}
          type="submit"
          variant={isActive ? 'danger' : 'accent'}
        >
          {isActive ? t('actions.confirmSuspend') : t('actions.confirmReactivate')}
        </Button>
        <Button
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          variant="quiet"
        >
          {t('actions.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Ajoute une note interne à l'historique du salon. */
export function TenantNoteForm({ tenantId }: { readonly tenantId: string }) {
  const t = useTranslations('platform');
  const router = useRouter();
  const refusal = useRefusal();
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (body.trim() === '') {
      setError(t('actions.noteEmpty'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await addTenantNoteAction(tenantId, { body: body.trim() });
      if (result.ok) {
        setBody('');
        router.refresh();
        return;
      }
      if (result.code === ERROR_CODES.VALIDATION_ERROR) {
        setError(t('actions.noteInvalid'));
        return;
      }
      const key = refusal(result);
      setError(key === null ? null : t(`errors.${key}`));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="spa-console-record__stack" noValidate onSubmit={(event) => void submit(event)}>
      <TextArea
        error={error ?? undefined}
        hint={t('actions.noteHint')}
        id={`note-${tenantId}`}
        label={t('actions.noteLabel')}
        maxLength={PLATFORM_NOTE_MAX_LENGTH}
        onChange={(event) => {
          setBody(event.target.value);
        }}
        placeholder={t('actions.notePlaceholder')}
        rows={3}
        value={body}
      />
      <div className="spa-console-record__buttons">
        <Button loading={pending} loadingLabel={t('actions.noteSaving')} type="submit" variant="accent">
          {t('actions.noteSubmit')}
        </Button>
      </div>
    </form>
  );
}
