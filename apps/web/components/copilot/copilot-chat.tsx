'use client';

import '@copilotkit/react-core/v2/styles.css';

import {
  CopilotKitProvider,
  CopilotPopup,
  CopilotSidebar,
  useAgentContext,
  useConfigureSuggestions,
  useFrontendTool,
} from '@copilotkit/react-core/v2';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { z } from 'zod';

import { isSalonPath } from '@/lib/copilot/paths';
import type { CopilotSuggestion } from '@/lib/copilot/suggestions';

/**
 * Le chat du copilot — P1-06 (#1453), EF-2 et EF-5 de la spécification.
 *
 * - **Panneau** dans le back-office, **bulle** sur le parcours public et
 *   l'espace client ; plein écran sous 480 px (`styles/components/copilot.css`).
 * - Habillé des **jetons du design system** : la feuille de CopilotKit lit des
 *   variables (`--background`, `--primary`…) que la nôtre redéfinit, thème
 *   sombre compris.
 * - **Suggestions d'ouverture** calculées par le serveur (étage 0) : celles qui
 *   mènent quelque part sont des liens, sans aucun appel au modèle ; celles qui
 *   posent une question deviennent des pastilles.
 * - **`naviguer`** : l'exécutant que le serveur déclenche pour mener la page
 *   (passe-plat d'un spécialiste, `guide_mener`). Il n'accepte qu'une adresse
 *   du salon courant, et Claude ne le voit jamais (`BROWSER_EXECUTORS`).
 */

export interface CopilotChatProps {
  /** `/{salon}/copilot`, `/{salon}/compte/copilot` ou `/{salon}/admin/copilot`. */
  readonly runtimeUrl: string;
  readonly tenantSlug: string;
  readonly variant: 'panneau' | 'bulle';
}

export default function CopilotChat(props: CopilotChatProps) {
  return (
    <CopilotKitProvider runtimeUrl={props.runtimeUrl}>
      <Chat {...props} />
    </CopilotKitProvider>
  );
}

function Chat({ runtimeUrl, tenantSlug, variant }: CopilotChatProps) {
  const t = useTranslations('copilot');
  const router = useRouter();
  const pathname = usePathname();
  const [suggestions, setSuggestions] = useState<readonly CopilotSuggestion[]>([]);

  // Les suggestions de l'écran : le serveur les calcule à partir de la session
  // et de la page, sans modèle. Une panne n'empêche pas de converser.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${runtimeUrl}/suggestions?page=${encodeURIComponent(pathname)}`, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<{ suggestions: CopilotSuggestion[] }>) : null))
      .then((body) => {
        setSuggestions(body?.suggestions ?? []);
      })
      .catch(() => {
        setSuggestions([]);
      });
    return () => {
      controller.abort();
    };
  }, [pathname, runtimeUrl]);

  // Contexte indicatif : il sert la pertinence, jamais l'autorisation.
  useAgentContext({ description: 'Page affichée', value: pathname });

  useFrontendTool(
    {
      name: 'naviguer',
      description: 'Exécutant du serveur : mène la page à une adresse du salon.',
      parameters: z.object({ chemin: z.string().max(512) }).strict(),
      handler: async ({ chemin }) => {
        if (!isSalonPath(chemin, tenantSlug)) return 'Adresse refusée.';
        const target = new URL(chemin, window.location.origin);
        // Même page, autre filtre : le tunnel lit son adresse au montage, un
        // rechargement est donc ce qui la lui fait relire.
        if (target.pathname === window.location.pathname) window.location.assign(chemin);
        else router.push(chemin);
        return 'Navigation faite.';
      },
    },
    [router, tenantSlug],
  );

  const label = useMemo(() => suggestionLabels(t), [t]);
  const questions = suggestions.filter((suggestion) => suggestion.type === 'message');
  const links = suggestions.filter(
    (suggestion): suggestion is Extract<CopilotSuggestion, { type: 'navigation' }> => suggestion.type === 'navigation',
  );

  useConfigureSuggestions(
    {
      suggestions: questions.flatMap((suggestion) => {
        const text = label[suggestion.cle];
        return text === undefined ? [] : [{ title: text, message: text }];
      }),
      available: 'before-first-message',
    },
    [questions.map((suggestion) => suggestion.cle).join(','), label],
  );

  const labels = {
    modalHeaderTitle: t('title'),
    chatInputPlaceholder: t('placeholder'),
    chatDisclaimerText: t('disclaimer'),
    chatToggleOpenLabel: t('open'),
    chatToggleCloseLabel: t('close'),
    welcomeMessageText: t('welcome'),
    assistantMessageToolbarCopyMessageLabel: t('copy'),
    assistantMessageToolbarCopyCodeLabel: t('copy'),
    assistantMessageToolbarCopyCodeCopiedLabel: t('copied'),
    userMessageToolbarCopyMessageLabel: t('copy'),
  };

  const welcomeScreen: WelcomeScreen = ({ input, suggestionView }) => (
    <div className="spa-copilot__welcome">
      <p className="spa-copilot__greeting">{t('welcome')}</p>
      {links.length === 0 ? null : (
        <nav className="spa-copilot__shortcuts" aria-label={t('shortcuts')}>
          {links.map((link) =>
            label[link.cle] === undefined ? null : (
              <Link key={link.cle} className="spa-button spa-button--neutral" href={link.chemin}>
                {label[link.cle]}
              </Link>
            ),
          )}
        </nav>
      )}
      {suggestionView}
      {input}
    </div>
  );

  return (
    <div className={`spa-copilot spa-copilot--${variant}`}>
      {variant === 'panneau' ? (
        <CopilotSidebar labels={labels} welcomeScreen={welcomeScreen} />
      ) : (
        <CopilotPopup labels={labels} welcomeScreen={welcomeScreen} />
      )}
    </div>
  );
}

type WelcomeScreen = NonNullable<Exclude<ComponentProps<typeof CopilotPopup>['welcomeScreen'], boolean | string>>;

/**
 * Le libellé de chaque suggestion, clé par clé et en toutes lettres — la règle
 * du dépôt interdit de composer une clé de traduction par concaténation.
 */
function suggestionLabels(t: ReturnType<typeof useTranslations<'copilot'>>): Record<string, string | undefined> {
  return {
    reserver: t('suggestions.reserver'),
    creneaux_demain: t('suggestions.creneaux_demain'),
    tarifs: t('suggestions.tarifs'),
    reprendre_dernier_soin: t('suggestions.reprendre_dernier_soin'),
    reporter_prochain: t('suggestions.reporter_prochain'),
    ma_journee: t('suggestions.ma_journee'),
    prochain_client: t('suggestions.prochain_client'),
    creneaux_libres_aujourdhui: t('suggestions.creneaux_libres_aujourdhui'),
    poser_rendez_vous: t('suggestions.poser_rendez_vous'),
    a_encaisser: t('suggestions.a_encaisser'),
    resume_journee: t('suggestions.resume_journee'),
  };
}
