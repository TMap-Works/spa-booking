'use client';

import dynamic from 'next/dynamic';

import type { CopilotChatProps } from './copilot-chat';

/**
 * Le chat, chargé **après** la page et côté navigateur seulement : CopilotKit
 * pèse lourd, et le parcours de réservation a un budget de LCP (skill
 * web-frontend §7). Rien n'est rendu côté serveur, rien ne retarde le premier
 * affichage.
 */
const CopilotChat = dynamic(() => import('./copilot-chat'), { ssr: false });

export function CopilotLauncher(props: CopilotChatProps) {
  return <CopilotChat {...props} />;
}
