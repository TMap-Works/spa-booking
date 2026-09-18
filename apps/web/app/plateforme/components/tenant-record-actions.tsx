'use client';

import {
  ERROR_CODES,
  PLATFORM_NOTE_MAX_LENGTH,
  PLATFORM_STATUS_REASON_MAX_LENGTH,
  type TenantAccessLinks,
} from '@spa/shared';
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
 */

/** Une session expirée renvoie à la connexion ; tout autre refus s'affiche. */
function useRefusal(): (result: PlatformActionResult<unknown>) => string | null {
  const router = useRouter();

  return (result) => {
    if (result.ok) {
      return null;
    }
    if (result.code === ERROR_CODES.UNAUTHORIZED) {
      router.replace(PLATFORM_SESSION_END_PATH);
      return null;
    }
    return result.message;
  };
}

/**
 * Renvoie les liens d'accès du gérant — une nouvelle invitation, que
 * l'historique garde.
 */
export function TenantAccessPanel({ tenantId }: { readonly tenantId: string }) {
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
      setError(
        result.code === ERROR_CODES.TENANT_ADMIN_MISSING
          ? 'Ce salon n’a aucun compte administrateur à réinviter.'
          : refusal(result),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="spa-console-record__stack">
      <p className="spa-admin-toolbar__hint">
        Émet une nouvelle invitation pour l’administrateur et affiche les trois liens à lui
        remettre. Sans effet sur un compte déjà activé, sinon de redonner l’adresse du
        back-office.
      </p>
      <Button
        loading={pending}
        loadingLabel="Réémission de l’invitation…"
        onClick={() => void reissue()}
        variant="neutral"
      >
        {links === null ? 'Renvoyer les liens d’accès' : 'Réémettre à nouveau'}
      </Button>
      {error === null ? null : (
        <Notification tone="danger" title="Liens indisponibles">
          <p>{error}</p>
        </Notification>
      )}
      {links === null ? null : (
        <>
          <p className="spa-admin-toolbar__hint">Nouvelle invitation émise pour {links.email}.</p>
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
  const router = useRouter();
  const refusal = useRefusal();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError('Indiquez le motif — il est gardé dans l’historique du salon.');
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
      setError(refusal(result));
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <div className="spa-console-record__stack">
        <p className="spa-admin-toolbar__hint">
          {isActive
            ? 'La suspension ferme la vitrine, la réservation et la connexion au back-office, et coupe les sessions ouvertes. Réversible.'
            : 'Le salon est suspendu : sa vitrine et son back-office répondent « introuvable ».'}
        </p>
        <Button
          onClick={() => {
            setOpen(true);
          }}
          variant={isActive ? 'danger' : 'accent'}
        >
          {isActive ? 'Suspendre le salon' : 'Réactiver le salon'}
        </Button>
      </div>
    );
  }

  return (
    <form className="spa-console-record__stack" noValidate onSubmit={(event) => void submit(event)}>
      <TextArea
        error={error ?? undefined}
        hint="Gardé dans l’historique du salon, visible des autres opérateurs."
        id={`statut-motif-${tenantId}`}
        label={isActive ? 'Motif de la suspension' : 'Motif de la réactivation'}
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
          loadingLabel={isActive ? 'Suspension…' : 'Réactivation…'}
          type="submit"
          variant={isActive ? 'danger' : 'accent'}
        >
          {isActive ? 'Confirmer la suspension' : 'Confirmer la réactivation'}
        </Button>
        <Button
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          variant="quiet"
        >
          Annuler
        </Button>
      </div>
    </form>
  );
}

/** Ajoute une note interne à l'historique du salon. */
export function TenantNoteForm({ tenantId }: { readonly tenantId: string }) {
  const router = useRouter();
  const refusal = useRefusal();
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (body.trim() === '') {
      setError('La note est vide.');
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
      setError(refusal(result));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="spa-console-record__stack" noValidate onSubmit={(event) => void submit(event)}>
      <TextArea
        error={error ?? undefined}
        hint="Visible des seuls opérateurs. Pas de données de clientes."
        id={`note-${tenantId}`}
        label="Ajouter une note"
        maxLength={PLATFORM_NOTE_MAX_LENGTH}
        onChange={(event) => {
          setBody(event.target.value);
        }}
        placeholder="Ex. : gérante relancée par téléphone, rappel prévu lundi."
        rows={3}
        value={body}
      />
      <div className="spa-console-record__buttons">
        <Button loading={pending} loadingLabel="Enregistrement…" type="submit" variant="accent">
          Enregistrer la note
        </Button>
      </div>
    </form>
  );
}
