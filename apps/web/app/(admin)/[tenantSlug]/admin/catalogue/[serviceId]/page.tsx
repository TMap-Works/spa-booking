import {
  hasAtLeastRole,
  type Service,
  type ServiceCategory,
  type ServiceStaffMember,
  type SessionUser,
  type StaffMember,
} from '@spa/shared';
import Link from 'next/link';

import { Notification } from '@/components/ui/notification';
import {
  ApiClientError,
  fetchOwnProfile,
  fetchService,
  fetchServiceCategories,
  fetchServiceStaff,
  fetchStaffMembers,
} from '@/lib/api-client';
import { sortStaffMembers } from '@/lib/admin/staff-directory';
import { formatDuration } from '@/lib/format';

import { CatalogStatusBadge } from '../../components/catalog-status-badge';
import { ServiceForm } from '../../components/service-form';
import { ServiceStaffPanel } from '../../components/service-staff-panel';
import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { adminCatalogPath, adminCatalogPreviewPath, adminServicePath } from '../../paths';

/**
 * Fiche d'une prestation — modification et affectation des praticiens (#52,
 * critères 1, 3 et 4).
 *
 * ## La devise est celle du prix déjà enregistré
 *
 * Et non celle de l'établissement : une prestation créée avant un changement de
 * devise garde la sienne, et la reformater dans une autre monnaie changerait son
 * prix sans que personne ne l'ait demandé.
 *
 * ## D'où vient la liste des praticiens affectables
 *
 * De `GET /v1/staff` (#421, branché ici par #455), l'annuaire des fiches
 * praticien de l'établissement — l'identifiant qu'il rend est celui qu'attend
 * `POST /services/{serviceId}/staff`. C'est ce qui rend possible la **toute
 * première** affectation d'un salon qui démarre.
 *
 * Le catalogue public ne sert plus à composer ces candidats, et n'est plus lu :
 * il ne portait que les fiches **déjà affectées** à une prestation active, si
 * bien qu'un salon sans aucune affectation nulle part ne voyait aucun candidat —
 * exactement l'écran dont il fallait sortir.
 *
 * La liste n'est pas filtrée sur l'activité : une fiche suspendue reste une
 * fiche de l'établissement, le back-office est justement l'endroit où on la
 * retrouve, et l'API accepte de l'affecter. Le panneau la propose donc, en
 * disant qu'elle est désactivée plutôt qu'en la masquant.
 *
 * ## Le rang qui écrit n'est pas celui qui ouvre la fiche
 *
 * `GET /v1/services/{id}` se lit dès le rang praticien ; l'enregistrement du
 * formulaire et l'affectation d'un praticien sont, eux, `@AuthAtLeast('MANAGER')`.
 * Le profil est donc lu ici et descendu aux deux panneaux, qui rendent la fiche
 * en lecture seule plutôt que de faire découvrir le refus à la soumission
 * (#619).
 */

export const dynamic = 'force-dynamic';

interface ServicePageProps {
  readonly params: Promise<{ readonly tenantSlug: string; readonly serviceId: string }>;
}

export default async function ServicePage({ params }: ServicePageProps) {
  const { tenantSlug, serviceId } = await params;
  const accessToken = await requireAdminAccessToken(
    tenantSlug,
    adminServicePath(tenantSlug, serviceId),
  );

  let service: Service;
  let categories: ServiceCategory[];
  let assigned: ServiceStaffMember[];
  let staff: StaffMember[];
  let profile: SessionUser;
  try {
    [service, categories, assigned, staff, profile] = await Promise.all([
      fetchService(accessToken, serviceId),
      fetchServiceCategories(accessToken, { activeOnly: true }),
      fetchServiceStaff(accessToken, serviceId),
      fetchStaffMembers(accessToken),
      fetchOwnProfile(accessToken),
    ]);
  } catch (error) {
    // Un 404 est le cas d'une prestation d'un autre établissement autant que
    // d'un identifiant inconnu — l'API ne distingue pas les deux, et l'écran
    // n'a pas à le faire non plus (tenant-isolation §4).
    if (error instanceof ApiClientError && error.status === 404) {
      return (
        <Notification tone="warning" title="Prestation introuvable">
          <p>
            Aucune prestation de ce salon ne porte cet identifiant. Elle a pu être créée dans un
            autre établissement.{' '}
            <Link href={adminCatalogPath(tenantSlug)}>Revenir au catalogue</Link>.
          </p>
        </Notification>
      );
    }

    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint: 'La modification du catalogue est réservée aux gérantes et aux administrateurs.',
      failedTitle: 'Prestation indisponible',
    });
  }

  // `GET /v1/staff` rejoint les trois autres lectures dans le `Promise.all` :
  // il ne rend pas de 404 — une liste vide est la réponse juste pour un salon
  // sans aucune fiche —, et il lit au rang `STAFF`, sous le seuil que la page
  // exige déjà. Aucun échec propre à traiter à part, contrairement au catalogue
  // public qu'il remplace : celui-là rendait 404 pour un salon désactivé, sur
  // une prestation qui existe et que l'écran affiche parfaitement.
  //
  // L'ordre de l'API (`orderBy: displayName`) est celui de la collation de la
  // base, et non celui du français : « Émilie » s'y range après « Zoé ». C'est
  // `sortStaffMembers` qui donne l'ordre d'affichage — le même que sur l'écran
  // Personnel —, actives d'abord puis `localeCompare` en `fr-FR`.
  const affected = new Set(assigned.map((member) => member.id));
  const candidates = sortStaffMembers(staff.filter((member) => !affected.has(member.id)));
  const canManage = hasAtLeastRole(profile.role, 'manager');

  return (
    <section aria-labelledby="prestation-titre">
      <h1 className="spa-admin__title" id="prestation-titre">
        {service.name}
      </h1>

      <div className="spa-admin-toolbar">
        <div className="spa-admin-toolbar__group">
          <CatalogStatusBadge isActive={service.isActive} />
          <span className="spa-admin-toolbar__hint">
            Bloque {formatDuration(service.occupiedMinutes)} sur l’agenda, tampons compris.
          </span>
        </div>
        <span className="spa-admin-toolbar__spacer" />
        <div className="spa-admin-toolbar__group">
          <Link className="spa-button spa-button--quiet" href={adminCatalogPath(tenantSlug)}>
            Retour au catalogue
          </Link>
          <Link
            className="spa-button spa-button--neutral"
            href={`${adminCatalogPreviewPath(tenantSlug)}#${service.slug}`}
          >
            Voir le rendu public
          </Link>
        </div>
      </div>

      <div className="spa-admin__split">
        <ServiceStaffPanel
          tenantSlug={tenantSlug}
          serviceId={service.id}
          assigned={assigned}
          candidates={candidates}
          canManage={canManage}
        />
        <ServiceForm
          tenantSlug={tenantSlug}
          currency={service.price.currency}
          categories={categories}
          service={service}
          canManage={canManage}
        />
      </div>
    </section>
  );
}
