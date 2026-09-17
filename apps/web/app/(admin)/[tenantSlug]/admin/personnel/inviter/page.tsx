import { hasAtLeastRole, type SessionUser } from '@spa/shared';
import Link from 'next/link';

import { Notification } from '@/components/ui/notification';
import { fetchOwnProfile } from '@/lib/api-client';

import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { StaffInviteForm } from '../components/staff-invite-form';
import { adminStaffInvitePath, adminStaffPath } from '../paths';

/**
 * Invitation d'un membre du personnel — l'écran (#766).
 *
 * Le formulaire est celui de #53, inchangé ; ce qui change est l'endroit d'où on
 * l'atteint. Il vivait déployé en permanence au bas de /personnel, à quelque
 * 1 050 px de défilement à 1280 px, son bouton « Inviter » accentué au même titre
 * que celui de la création de fiche : deux actions primaires et aucune
 * hiérarchie, quand la maquette de l'écran n'en pose qu'une. Il a désormais son
 * adresse, appelée depuis la barre d'outils de la liste — comme « Nouvelle
 * prestation » appelle /catalogue/nouveau.
 *
 * ## Le rang est relu ici
 *
 * Inviter, changer un rôle, désactiver un accès exigent `ADMIN` : tout ce qui
 * change ce qu'une personne *peut faire*. La barre d'outils n'offre donc le lien
 * qu'à ce rang, mais une adresse se saisit et un signet se garde — sans cette
 * borne, l'écran servirait ses cinq champs à un compte qui n'obtiendra que le
 * 403 de `POST /v1/users/invitations`. Ce n'est pas une garde : c'est l'écran qui
 * dit ce qu'il en est avant la première frappe (#619).
 */

export const dynamic = 'force-dynamic';

interface InviteStaffPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function InviteStaffPage({ params }: InviteStaffPageProps) {
  const { tenantSlug } = await params;
  const accessToken = await requireAdminAccessToken(tenantSlug, adminStaffInvitePath(tenantSlug));

  let profile: SessionUser;

  try {
    profile = await fetchOwnProfile(accessToken);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint:
        'La gestion du personnel est réservée aux comptes du salon. Demandez l’accès à l’administrateur.',
      failedTitle: 'Formulaire indisponible',
    });
  }

  if (!hasAtLeastRole(profile.role, 'admin')) {
    return (
      <Notification tone="warning" title="Accès réservé">
        <p>
          L’invitation d’un membre du personnel est réservée au rang administrateur. La liste du
          personnel reste consultable, et un administrateur du salon peut émettre l’invitation pour
          vous. <Link href={adminStaffPath(tenantSlug)}>Revenir au personnel</Link>.
        </p>
      </Notification>
    );
  }

  return (
    <section aria-labelledby="invitation-nouvelle">
      <h1 className="spa-admin__title" id="invitation-nouvelle">
        Inviter un membre du personnel
      </h1>

      <div className="spa-admin-toolbar">
        <Link className="spa-button spa-button--quiet" href={adminStaffPath(tenantSlug)}>
          Retour au personnel
        </Link>
      </div>

      <StaffInviteForm tenantSlug={tenantSlug} />
    </section>
  );
}
