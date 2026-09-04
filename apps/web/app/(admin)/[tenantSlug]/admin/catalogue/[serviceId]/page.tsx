import type { PublicService, Service, ServiceCategory, ServiceStaffMember, StaffMemberSummary } from '@spa/shared';
import Link from 'next/link';

import { Notification } from '@/components/ui/notification';
import {
  ApiClientError,
  fetchPublicServices,
  fetchService,
  fetchServiceCategories,
  fetchServiceStaff,
} from '@/lib/api-client';
import { formatDuration } from '@/lib/format';

import { CatalogStatusBadge } from '../../components/catalog-status-badge';
import { ServiceForm } from '../../components/service-form';
import { ServiceStaffPanel } from '../../components/service-staff-panel';
import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { adminCatalogPath, adminCatalogPreviewPath } from '../../paths';

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
 * Du catalogue public (`GET /public/{slug}/services`), qui porte pour chaque
 * prestation active les fiches praticien qui la tiennent. L'API du back-office
 * n'expose à ce jour aucun « tous les praticiens de l'établissement » :
 * `GET /v1/users` rend des **comptes**, dont l'identifiant n'est pas celui d'une
 * fiche praticien, et `POST …/staff` attend le second. Composer les candidats
 * ainsi est ce que le contrat permet sans en inventer un ; la limite — un
 * praticien qui ne pratique encore aucune prestation n'apparaît pas — est écrite
 * sur l'écran et fait l'objet d'une issue de suivi.
 */

export const dynamic = 'force-dynamic';

interface ServicePageProps {
  readonly params: Promise<{ readonly tenantSlug: string; readonly serviceId: string }>;
}

/**
 * Les praticiens que le catalogue public connaît, dédoublonnés.
 *
 * Une même fiche tient plusieurs prestations : sans ce dédoublonnage, la liste
 * de choix répéterait le même nom autant de fois qu'il pratique de soins.
 */
function knownStaff(catalog: readonly PublicService[]): StaffMemberSummary[] {
  const byId = new Map<string, StaffMemberSummary>();

  for (const service of catalog) {
    for (const member of service.staff) {
      byId.set(member.id, member);
    }
  }

  return [...byId.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName, 'fr'),
  );
}

export default async function ServicePage({ params }: ServicePageProps) {
  const { tenantSlug, serviceId } = await params;
  const accessToken = await requireAdminAccessToken(tenantSlug);

  let service: Service;
  let categories: ServiceCategory[];
  let assigned: ServiceStaffMember[];
  try {
    [service, categories, assigned] = await Promise.all([
      fetchService(accessToken, serviceId),
      fetchServiceCategories(accessToken, { activeOnly: true }),
      fetchServiceStaff(accessToken, serviceId),
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

  // Le catalogue **public** est lu à part, et son échec ne fait pas échouer la
  // page : il ne sert qu'à composer la liste des praticiens affectables. Réuni
  // aux trois lectures ci-dessus, son 404 — celui d'un salon désactivé, dont la
  // vitrine n'est plus servie — aurait été rendu comme « prestation
  // introuvable », sur une prestation qui existe et que l'écran affiche
  // parfaitement. Sans candidats, le panneau dit déjà ce qu'il en est.
  const catalog: PublicService[] = await fetchPublicServices(tenantSlug).catch(
    (error: unknown): PublicService[] => {
      if (error instanceof ApiClientError) {
        return [];
      }
      throw error;
    },
  );

  const affected = new Set(assigned.map((member) => member.id));
  const candidates = knownStaff(catalog).filter((member) => !affected.has(member.id));

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
        />
        <ServiceForm
          tenantSlug={tenantSlug}
          currency={service.price.currency}
          categories={categories}
          service={service}
        />
      </div>
    </section>
  );
}
