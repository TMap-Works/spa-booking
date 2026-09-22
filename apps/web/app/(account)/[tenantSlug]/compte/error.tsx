'use client';

import { useTranslations } from 'next-intl';

import { RouteError } from '@/components/ui/route-error';

interface AccountErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

/**
 * Un écran de l'espace client qui n'a pas pu se rendre (#830).
 *
 * Posée sous le gabarit du compte : le titre « Mon compte », la barre du compte
 * et le pied — « Prendre un nouveau rendez-vous », et « Mon compte » quand il ne
 * ramène pas à l'écran courant (#749) — restent affichés, si bien que la cliente
 * a toujours une issue en plus de la reprise.
 * Le gabarit porte déjà le titre de niveau 1 ; l'encart n'en ajoute pas.
 */
export default function AccountError({ reset }: AccountErrorProps) {
  const t = useTranslations('account.pageError');

  return <RouteError message={t('message')} reset={reset} title={t('title')} />;
}
