import type { Metadata } from 'next';

import { AuthScreen, type AuthHighlight } from '@/components/auth/auth-screen';
import { PHOTOS } from '@/lib/photos';
import { PLAN_PROMISE } from '@/lib/plan';
import { PLATFORM_HOME_PATH, PLATFORM_NAME } from '@/lib/platform';

import { SignupForm } from './components/signup-form';

import '../../styles/admin/index.css';

/**
 * L'inscription d'un salon en libre-service — ADR 0016.
 *
 * `inscription` est un slug réservé (`RESERVED_TENANT_SLUGS`) : aucun salon ne
 * peut s'y ouvrir, et le segment statique l'emporte sur `[tenantSlug]`.
 */

export const metadata: Metadata = {
  title: `Ouvrir mon salon — ${PLATFORM_NAME}`,
  description:
    `Créez votre page de réservation en ligne en quelques minutes : ${PLAN_PROMISE}, sans engagement.`,
};

const SIGNUP_HIGHLIGHTS: readonly AuthHighlight[] = [
  { icon: 'calendar', text: 'Vos clientes réservent en ligne, 24 h/24' },
  { icon: 'bell', text: 'Confirmations et rappels envoyés pour vous' },
  { icon: 'users', text: 'Planning, équipe et fiches clientes' },
  { icon: 'shield', text: `${PLAN_PROMISE} — sans engagement` },
];

export default function SignupPage() {
  return (
    <AuthScreen
      salonName={null}
      headline="Ouvrez votre salon en ligne"
      lead="Quelques minutes suffisent : votre page de réservation, votre planning et votre caisse, au même endroit."
      highlights={SIGNUP_HIGHLIGHTS}
      photo={PHOTOS.spaInterieur}
      exits={[{ href: PLATFORM_HOME_PATH, label: `Accueil ${PLATFORM_NAME}` }]}
    >
      <SignupForm />
    </AuthScreen>
  );
}
