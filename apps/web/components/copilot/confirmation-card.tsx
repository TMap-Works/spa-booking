'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import type { WriteOutcome } from '@/lib/copilot/writes';

/**
 * La carte qui fait valider une écriture du copilot — P3-01 (#1461).
 *
 * Elle affiche ce que le serveur a gardé, et n'envoie que son identifiant et
 * la décision : ce qui part est exactement ce qui a été lu. Les deux boutons
 * se désactivent dès le premier clic — un double clic ne doit jamais faire
 * partir deux écritures —, et le résultat est annoncé (`role="status"`).
 */
export interface ConfirmationCardProps {
  readonly runtimeUrl: string;
  readonly id: string;
  readonly titre: string;
  readonly lignes: readonly string[];
}

export function ConfirmationCard({ runtimeUrl, id, titre, lignes }: ConfirmationCardProps) {
  const t = useTranslations('copilot');
  const [state, setState] = useState<'attente' | 'envoi' | WriteOutcome>('attente');

  const decide = async (decision: 'valider' | 'refuser') => {
    setState('envoi');
    try {
      const response = await fetch(`${runtimeUrl}/ecritures/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      setState(
        response.ok
          ? ((await response.json()) as WriteOutcome)
          : { statut: 'echec', message: t('confirmation.envoi') },
      );
    } catch {
      setState({ statut: 'echec', message: t('confirmation.envoi') });
    }
  };

  const done = typeof state === 'object';

  return (
    <section className="spa-copilot__confirmation" aria-label={t('confirmation.label')}>
      <p className="spa-copilot__confirmation-title">{titre}</p>
      <ul className="spa-copilot__confirmation-lines">
        {lignes.map((ligne) => (
          <li key={ligne}>{ligne}</li>
        ))}
      </ul>
      {done ? null : (
        <div className="spa-copilot__confirmation-actions">
          <Button
            variant="accent"
            loading={state === 'envoi'}
            loadingLabel={t('confirmation.envoi')}
            disabled={state !== 'attente'}
            onClick={() => void decide('valider')}
          >
            {t('confirmation.valider')}
          </Button>
          <Button variant="neutral" disabled={state !== 'attente'} onClick={() => void decide('refuser')}>
            {t('confirmation.refuser')}
          </Button>
        </div>
      )}
      <p className="spa-copilot__confirmation-result" role="status">
        {done ? state.message : null}
      </p>
    </section>
  );
}
