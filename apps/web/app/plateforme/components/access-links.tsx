'use client';

import type { TenantAccessLinks } from '@spa/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Les trois liens que l'éditeur remet au gérant d'un salon.
 *
 * Le lien d'invitation porte un jeton à usage unique : il ne sert qu'une fois,
 * à poser le premier mot de passe, et une nouvelle invitation peut être réémise
 * depuis la liste des salons. Il est affiché ici et nulle part ailleurs.
 */

function expiryLabel(seconds: number): string {
  const days = Math.round(seconds / 86_400);

  return days >= 1 ? `${String(days)} jour${days > 1 ? 's' : ''}` : `${String(Math.round(seconds / 3600))} h`;
}

function CopyableLink({ id, label, hint, url }: { id: string; label: string; hint: string; url: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Presse-papiers refusé (HTTP, permission) : le lien reste sélectionnable.
    }
  };

  return (
    <div className="spa-platform-link">
      <label className="spa-platform-link__label" htmlFor={id}>
        {label}
      </label>
      <p className="spa-platform-link__hint">{hint}</p>
      <div className="spa-platform-link__row">
        <input
          className="spa-field__control spa-platform-link__value"
          id={id}
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button variant="neutral" onClick={() => void copy()}>
          {copied ? 'Copié' : 'Copier'}
        </Button>
      </div>
    </div>
  );
}

export function AccessLinks({ idPrefix, links }: { idPrefix: string; links: TenantAccessLinks }) {
  return (
    <div className="spa-platform-links">
      <CopyableLink
        id={`${idPrefix}-invitation`}
        label="1. Lien d’activation du gérant"
        hint={`À envoyer au gérant : il y choisit son mot de passe et arrive dans son back-office. Valable ${expiryLabel(links.invitationExpiresIn)}, une seule fois.`}
        url={links.adminInvitationUrl}
      />
      <CopyableLink
        id={`${idPrefix}-admin`}
        label="2. Back-office du salon"
        hint="L’adresse de connexion du gérant et de son équipe, une fois le compte activé."
        url={links.adminLoginUrl}
      />
      <CopyableLink
        id={`${idPrefix}-booking`}
        label="3. Page de réservation"
        hint="Le lien public que le salon partage à ses clientes."
        url={links.bookingUrl}
      />
    </div>
  );
}
