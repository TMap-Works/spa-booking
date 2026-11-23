'use client';

import '@copilotkit/react-core/v2/styles.css';

import {
  CopilotKitProvider,
  CopilotPopup,
  CopilotSidebar,
  useAgent,
  useAgentContext,
  useConfigureSuggestions,
  useFrontendTool,
} from '@copilotkit/react-core/v2';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, type ComponentProps, type MutableRefObject } from 'react';
import { z } from 'zod';

import { describePage, isSalonPath } from '@/lib/copilot/paths';
import type { CopilotSuggestion } from '@/lib/copilot/suggestions';

import { ConfirmationCard } from './confirmation-card';
import { pointTo } from './curseur-fantome';
import { isAuthPath, remplirFormulaire } from './remplir-formulaire';
import { describeStored, freshConversation, loadConversation, saveConversation, type Conversation } from './memoire';

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
  /**
   * Sur les pages publiques seulement : la route de l'espace client. Le cookie de
   * session n'est envoyé qu'aux adresses `/compte` et `/admin`, donc la route
   * publique ne reconnaît jamais personne. Le chat demande d'abord à celle du
   * compte qui parle ; si c'est une cliente connectée, toute la conversation passe
   * par cette route, et le serveur lit alors son vrai cookie.
   */
  readonly compteRuntimeUrl?: string;
}

/** Une cliente connectée : la route du compte rend l'empreinte de son compte, jamais `visiteur`. */
export async function sondeSession(compteRuntimeUrl: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${compteRuntimeUrl}/suggestions?page=%2F`, { signal, credentials: 'same-origin' });
    if (!response.ok) return false;
    const body = (await response.json()) as { sujet?: unknown };
    return typeof body.sujet === 'string' && body.sujet !== 'visiteur' && body.sujet !== 'inconnu';
  } catch {
    return false;
  }
}

export default function CopilotChat(props: CopilotChatProps) {
  const { compteRuntimeUrl } = props;
  // `null` tant que la sonde n'a pas répondu : le chat ne se monte qu'une fois la route connue.
  const [runtimeUrl, setRuntimeUrl] = useState<string | null>(compteRuntimeUrl === undefined ? props.runtimeUrl : null);

  useEffect(() => {
    if (compteRuntimeUrl === undefined) {
      setRuntimeUrl(props.runtimeUrl);
      return;
    }
    const controller = new AbortController();
    void sondeSession(compteRuntimeUrl, controller.signal).then((connectee) => {
      if (!controller.signal.aborted) setRuntimeUrl(connectee ? compteRuntimeUrl : props.runtimeUrl);
    });
    return () => controller.abort();
  }, [compteRuntimeUrl, props.runtimeUrl]);

  if (runtimeUrl === null) return null;
  return (
    <CopilotKitProvider key={runtimeUrl} runtimeUrl={runtimeUrl}>
      <Chat {...props} runtimeUrl={runtimeUrl} />
    </CopilotKitProvider>
  );
}

function Chat({ runtimeUrl, tenantSlug, variant }: CopilotChatProps) {
  const t = useTranslations('copilot');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [suggestions, setSuggestions] = useState<readonly CopilotSuggestion[]>([]);
  // La conversation reprise, connue une fois la personne identifiée par le serveur.
  const [conversation, setConversation] = useState<Conversation | null>(null);

  // Les suggestions de l'écran : le serveur les calcule à partir de la session
  // et de la page, sans modèle. Une panne n'empêche pas de converser.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${runtimeUrl}/suggestions?page=${encodeURIComponent(pathname)}`, { signal: controller.signal })
      .then((response) =>
        response.ok ? (response.json() as Promise<{ suggestions: CopilotSuggestion[]; sujet?: string }>) : null,
      )
      .then((body) => {
        setSuggestions(body?.suggestions ?? []);
        // Une seule fois : le fil ne change plus en cours de route.
        beacon(runtimeUrl, 'chargement', { sujet: body?.sujet ?? 'inconnu', stockage: describeStored(tenantSlug, variant, body?.sujet ?? 'inconnu') });
        setConversation((current) => current ?? loadConversation(tenantSlug, variant, body?.sujet ?? 'inconnu'));
        sujetRef.current = body?.sujet ?? 'inconnu';
      })
      .catch(() => {
        // Une requête **annulée** (le composant se démonte, puis se remonte : mode strict de
        // React en développement, changement de page) n'est pas une panne : l'autre requête
        // prend le relais. La traiter en panne effaçait la conversation gardée, puisqu'on ne
        // sait pas alors à qui elle est.
        if (controller.signal.aborted) return;
        setSuggestions([]);
        // Une vraie panne : un fil neuf, sans toucher à la conversation gardée.
        setConversation((current) => current ?? freshConversation());
        sujetRef.current = 'inconnu';
      });
    return () => {
      controller.abort();
    };
  }, [pathname, runtimeUrl, tenantSlug, variant]);

  const sujetRef = useRef('inconnu');
  useRememberedConversation(conversation, tenantSlug, variant, sujetRef, runtimeUrl);

  // Contexte indicatif : la page et ses filtres en cours (planning en semaine du
  // 23, tunnel sur l'après-midi…). Il sert la pertinence, jamais l'autorisation.
  useAgentContext({ description: 'Page affichée et filtres en cours', value: describePage(pathname, searchParams) });

  useFrontendTool(
    {
      name: 'naviguer',
      description: 'Exécutant du serveur : mène la page à une adresse du salon.',
      parameters: z.object({ chemin: z.string().max(512) }).strict(),
      handler: async ({ chemin }) => {
        if (!isSalonPath(chemin, tenantSlug)) return 'Adresse refusée.';
        // Le curseur fantôme montre d'abord le lien qui y mène (P4-03).
        await pointTo(chemin);
        const target = new URL(chemin, window.location.origin);
        if (target.pathname !== window.location.pathname) router.push(chemin);
        else if (target.pathname === `/${tenantSlug}/reservation`) {
          // Le tunnel relit son adresse au geste retour (`popstate`) : on la change
          // comme le ferait un clic, sans recharger — le chat et la saisie restent là.
          window.history.pushState(null, '', chemin);
          window.dispatchEvent(new PopStateEvent('popstate'));
        } else {
          // Même page, autre filtre : ces écrans lisent leur adresse au montage ou
          // sur le serveur ; un rechargement est ce qui la leur fait relire.
          window.location.assign(chemin);
        }
        return 'Navigation faite.';
      },
    },
    [router, tenantSlug],
  );

  // Le formulaire d'inscription ou de connexion, pré-rempli avec ce que la
  // personne a dit. Il ne pose que quatre champs, ni mot de passe ni validation.
  useFrontendTool(
    {
      name: 'remplir_formulaire',
      description: "Exécutant du serveur : pose dans le formulaire affiché ce que la personne a donné.",
      parameters: z
        .object({
          prenom: z.string().max(80).optional(),
          nom: z.string().max(80).optional(),
          email: z.string().max(254).optional(),
          telephone: z.string().max(24).optional(),
        })
        .strict(),
      handler: async (valeurs) => {
        if (!isAuthPath(window.location.pathname, tenantSlug)) return "Aucun formulaire d'inscription ou de connexion à remplir ici.";
        const { remplis, absents } = remplirFormulaire(valeurs);
        return absents.length === 0 ? `Champs remplis : ${remplis.join(', ')}.` : `Remplis : ${remplis.join(', ') || 'aucun'}. Absents de l'écran : ${absents.join(', ')}.`;
      },
    },
    [tenantSlug],
  );

  // L'écriture proposée par un spécialiste (P3-01) : une carte à valider. Le
  // clic part vers le serveur, pas vers le modèle ; l'outil, lui, rend la main
  // tout de suite pour que le chat ne reste pas en attente.
  useFrontendTool(
    {
      name: 'confirmer',
      description: "Exécutant du serveur : affiche une action à valider.",
      parameters: z
        .object({ id: z.string().uuid(), titre: z.string().max(200), lignes: z.array(z.string().max(300)).max(10) })
        .strict(),
      handler: async () => 'Carte affichée.',
      render: ({ args }) =>
        typeof args.id === 'string' && typeof args.titre === 'string' ? (
          <ConfirmationCard runtimeUrl={runtimeUrl} id={args.id} titre={args.titre} lignes={args.lignes ?? []} />
        ) : null,
    },
    [runtimeUrl],
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
      {/* Transparence (spécification §8) : le chat se dit assistant IA dès
          l'ouverture, et renvoie à la politique de données du salon. */}
      <p className="spa-copilot__notice">
        {t('aiNotice')}{' '}
        <Link href={`/${tenantSlug}/politique-donnees`}>{t('privacyLink')}</Link>
      </p>
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

  // Le fil est fixé avant la première ouverture : tant que la personne n'est pas
  // identifiée, rien ne s'affiche (une fraction de seconde), plutôt qu'un fil qui change.
  if (conversation === null) return null;

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

/**
 * Rend à l'agent la conversation gardée, puis la garde à chaque message.
 * Le serveur retrouve l'historique par le même fil ; l'écran, lui, le retrouve ici.
 */
function useRememberedConversation(
  conversation: Conversation | null,
  tenantSlug: string,
  variant: string,
  sujet: MutableRefObject<string>,
  runtimeUrl: string,
) {
  // L'agent partagé du chat, celui que la bulle ou le panneau affiche.
  const { agent } = useAgent();

  useEffect(() => {
    if (conversation === null) return;
    // Le fil est posé ici, sur l'agent, et **pas** passé au composant : avec un fil
    // explicite, CopilotKit se « reconnecte » à chaque montage, demande l'historique
    // au serveur et efface les messages affichés. Le serveur retrouve le même fil
    // par l'identifiant, et l'écran par la mémoire ci-dessous.
    agent.threadId = conversation.threadId;
    const trace = (what: string, count: number) => {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console -- trace de développement : voir si la conversation est gardée puis rendue.
        console.info(`[copilot-memoire] ${what} (${count} messages, fil ${conversation.threadId.slice(0, 8)})`);
      }
      beacon(runtimeUrl, what, { messages: count, fil: conversation.threadId.slice(0, 8), fil_agent: String(agent.threadId).slice(0, 8), stockage: describeStored(tenantSlug, variant, sujet.current) });
    };
    const save = () => {
      if (agent.messages.length === 0) return;
      saveConversation(tenantSlug, variant, sujet.current, { threadId: conversation.threadId, messages: agent.messages });
      trace('gardée', agent.messages.length);
    };
    // Rend à l'agent la **dernière** conversation gardée, relue à chaque fois : CopilotKit
    // peut remplacer son agent en cours de route (le serveur répond après coup), et celui
    // qui arrive est vide. Ce que le premier chargement avait lu serait alors périmé.
    const restore = () => {
      if (agent.messages.length > 0) return;
      const saved = loadConversation(tenantSlug, variant, sujet.current);
      if (saved.threadId === conversation.threadId && saved.messages.length > 0) {
        agent.setMessages(saved.messages);
        trace('rendue', saved.messages.length);
      } else {
        trace('rien à rendre', 0);
      }
    };
    restore();
    const subscription = agent.subscribe({
      // L'agent ne dit pas `onMessagesChanged` quand on lui **ajoute** un message (celui de
      // la personne) : sans `onNewMessage`, une page rechargée juste après l'envoi le perdrait.
      onNewMessage: save,
      onMessagesChanged: () => {
        if (agent.messages.length === 0) restore();
        else save();
      },
    });
    // Une page qui se décharge en pleine réponse : on garde ce qui est déjà là.
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      subscription.unsubscribe();
    };
  }, [agent, conversation, tenantSlug, variant, sujet, runtimeUrl]);
}

/**
 * En développement seulement : dit au serveur ce que la mémoire a fait, pour qu'on
 * le lise dans son journal sans la console du navigateur. Rien en production.
 */
function beacon(runtimeUrl: string, event: string, detail: Record<string, string | number>) {
  if (process.env.NODE_ENV === 'production') return;
  try {
    navigator.sendBeacon(`${runtimeUrl}/trace`, JSON.stringify({ event, ...detail, page: window.location.pathname + window.location.search }));
  } catch {
    // Une trace perdue ne change rien.
  }
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
