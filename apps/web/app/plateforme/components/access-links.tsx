'use client';

import type { TenantAccessLinks } from '@spa/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Les trois liens que l'éditeur remet au gérant d'un salon.
 *
 * Le lien d'invitation porte un jeton à usage unique : il ne sert qu'une fois,
 * à poser le premier mot de passe, et une nouvelle invitation peut être réémise
 * depuis la liste des salons. Il est affiché ici et nulle part ailleurs.
 */

/** Ce que porte un lien : son libellé, ce qu'il sert, et l'adresse elle-même. */
interface CopyableLinkProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly url: string;
}

function CopyableLink({ id, label, hint, url }: CopyableLinkProps) {
  const t = useTranslations('platform');
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
          {copied ? t('access.copied') : t('access.copy')}
        </Button>
      </div>
    </div>
  );
}

export function AccessLinks({ idPrefix, links }: { idPrefix: string; links: TenantAccessLinks }) {
  const t = useTranslations('platform');
  // Le délai d'expiration s'annonce en jours dès qu'il en couvre un ; en heures
  // sinon. Deux clés et non une règle de pluriel sur une même phrase : « 1 jour »
  // et « 7 jours » ne sont pas la même forme dans les deux langues.
  const seconds = links.invitationExpiresIn;
  const days = Math.round(seconds / 86_400);
  const expiry =
    days >= 1
      ? t('access.expiryDays', { count: days })
      : t('access.expiryHours', { count: Math.round(seconds / 3600) });

  return (
    <div className="spa-platform-links">
      <CopyableLink
        id={`${idPrefix}-invitation`}
        label={t('access.invitationLabel')}
        hint={t('access.invitationHint', { expiry })}
        url={links.adminInvitationUrl}
      />
      <CopyableLink
        id={`${idPrefix}-admin`}
        label={t('access.adminLabel')}
        hint={t('access.adminHint')}
        url={links.adminLoginUrl}
      />
      <CopyableLink
        id={`${idPrefix}-booking`}
        label={t('access.bookingLabel')}
        hint={t('access.bookingHint')}
        url={links.bookingUrl}
      />
    </div>
  );
}
