import { hasAtLeastRole, type Service, type SessionUser } from '@spa/shared';
import Link from 'next/link';

import { fetchOwnProfile, fetchServices } from '@/lib/api-client';
import { formatDuration, formatMoney } from '@/lib/format';

import { CatalogStatusBadge } from '../components/catalog-status-badge';
import { ServiceActivationButton } from '../components/service-activation-button';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import {
  adminCatalogPath,
  adminCatalogPreviewPath,
  adminNewServicePath,
  adminServiceCategoriesPath,
  adminServicePath,
} from '../paths';

/**
 * Le catalogue des prestations (#52, premier critère).
 *
 * ## Server Component, et rendu à la demande
 *
 * Le tableau est du texte : rien n'y a d'état, et le faire basculer côté client
 * ne rendrait que le poids du bundle. Seuls les deux boutons d'activation le
 * sont, aussi bas que possible dans l'arbre (web-frontend §1).
 *
 * `force-dynamic` parce que la page lit un cookie de session : la mettre en
 * cache servirait le catalogue du premier arrivé à tout le monde.
 *
 * ## Pourquoi les prestations désactivées sont affichées par défaut
 *
 * C'est le back-office : on y vient précisément pour retrouver une prestation
 * retirée du catalogue et la remettre en ligne. Le filtre « actives seulement »
 * existe pour l'autre besoin — vérifier ce que la cliente voit —, et il passe
 * par l'URL plutôt que par un état local, de sorte qu'un lien vers la vue
 * filtrée se partage et survive à un rafraîchissement.
 *
 * ## Le rôle décide de ce que l'écran propose, il ne protège rien
 *
 * `POST` et `PATCH /v1/services` sont `@AuthAtLeast('MANAGER')`, quand la lecture
 * s'ouvre dès le rang praticien. Offrir « Nouvelle prestation » et les bascules
 * d'activité à un compte `staff`, c'était lui faire découvrir le refus après
 * coup — neuf champs saisis, puis « Droits insuffisants » (#619). La colonne
 * « Actions » disparaît donc pour ce rôle, comme sur la liste du personnel, et la
 * barre d'outils dit pourquoi plutôt que de faire disparaître sans un mot. La
 * seule garde qui compte reste celle de l'API, qu'aucun front ne contourne.
 */

/**
 * Ce que dit l'écran vide, selon le filtre **et** selon ce que le rôle peut
 * faire : inviter une praticienne à créer une prestation, c'est lui proposer
 * exactement le geste que l'API refusera.
 */
function emptyCatalogDescription(activeOnly: boolean, canManage: boolean): string {
  if (activeOnly) {
    return canManage
      ? 'Toutes les prestations du salon sont désactivées : la page publique n’en propose aucune. Retirez le filtre pour les retrouver et en réactiver une.'
      : 'Toutes les prestations du salon sont désactivées : la page publique n’en propose aucune. Retirez le filtre pour les retrouver — leur réactivation est réservée au rang gérant.';
  }

  return canManage
    ? 'Créez votre première prestation pour que la page publique du salon propose quelque chose à réserver.'
    : 'Aucune prestation n’est enregistrée : la page publique du salon ne propose rien à réserver. La création d’une prestation est réservée au rang gérant.';
}

export const dynamic = 'force-dynamic';

interface CatalogPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<{ readonly actives?: string }>;
}

export default async function CatalogPage({ params, searchParams }: CatalogPageProps) {
  const { tenantSlug } = await params;
  const { actives } = await searchParams;
  const activeOnly = actives === '1';
  // Le filtre voyage avec la garde : un renouvellement de session doit rendre la
  // main sur la liste qu'on regardait, pas sur le catalogue entier (#458).
  const accessToken = await requireAdminAccessToken(
    tenantSlug,
    adminCatalogPath(tenantSlug, { activeOnly }),
  );

  let services: Service[];
  let profile: SessionUser;
  try {
    // Deux lectures indépendantes : les enchaîner ajouterait un aller-retour à
    // l'ouverture de l'écran.
    [services, profile] = await Promise.all([
      fetchServices(accessToken, { activeOnly }),
      fetchOwnProfile(accessToken),
    ]);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint:
        'Le catalogue est réservé aux comptes du salon. Demandez l’accès à l’administrateur.',
      failedTitle: 'Catalogue indisponible',
    });
  }

  const canManage = hasAtLeastRole(profile.role, 'manager');

  return (
    <section aria-labelledby="catalogue-titre">
      <h1 className="spa-admin__title" id="catalogue-titre">
        Catalogue des prestations
      </h1>

      <div className="spa-admin-toolbar">
        <div className="spa-admin-toolbar__group">
          <Link
            className="spa-button spa-button--quiet"
            href={adminCatalogPath(tenantSlug)}
            aria-current={activeOnly ? undefined : 'page'}
          >
            Toutes
          </Link>
          <Link
            className="spa-button spa-button--quiet"
            href={adminCatalogPath(tenantSlug, { activeOnly: true })}
            aria-current={activeOnly ? 'page' : undefined}
          >
            Actives seulement
          </Link>
        </div>
        <span className="spa-admin-toolbar__spacer" />
        <div className="spa-admin-toolbar__group">
          <Link className="spa-button spa-button--neutral" href={adminServiceCategoriesPath(tenantSlug)}>
            Rubriques
          </Link>
          <Link className="spa-button spa-button--neutral" href={adminCatalogPreviewPath(tenantSlug)}>
            Aperçu public
          </Link>
          {canManage ? (
            <Link className="spa-button spa-button--accent" href={adminNewServicePath(tenantSlug)}>
              Nouvelle prestation
            </Link>
          ) : (
            <span className="spa-admin-toolbar__hint">
              La création et la modification des prestations sont réservées au rang gérant.
            </span>
          )}
        </div>
      </div>

      {services.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">
            {activeOnly ? 'Aucune prestation en ligne' : 'Catalogue vide'}
          </p>
          <p className="spa-empty-state__description">
            {emptyCatalogDescription(activeOnly, canManage)}
          </p>
        </div>
      ) : (
        <div className="spa-admin__section">
          <table className="spa-admin-table">
            <caption className="spa-visually-hidden">
              {activeOnly
                ? 'Prestations actives du salon.'
                : 'Prestations du salon, actives et désactivées.'}
            </caption>
            <thead>
              <tr>
                <th className="spa-admin-table__head" scope="col">
                  Prestation
                </th>
                <th className="spa-admin-table__head" scope="col">
                  Rubrique
                </th>
                <th className="spa-admin-table__head" scope="col">
                  Durée
                </th>
                <th className="spa-admin-table__head" scope="col">
                  Tampons
                </th>
                <th className="spa-admin-table__head" scope="col">
                  Agenda
                </th>
                <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                  Prix
                </th>
                <th className="spa-admin-table__head" scope="col">
                  État
                </th>
                {canManage ? (
                  <th className="spa-admin-table__head" scope="col">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr className="spa-admin-table__row" key={service.id}>
                  <td className="spa-admin-table__cell">
                    <Link href={adminServicePath(tenantSlug, service.id)}>{service.name}</Link>
                  </td>
                  <td className="spa-admin-table__cell">{service.category?.name ?? 'Non classée'}</td>
                  <td className="spa-admin-table__cell">{formatDuration(service.durationMinutes)}</td>
                  <td className="spa-admin-table__cell">
                    {service.bufferBeforeMinutes} / {service.bufferAfterMinutes} min
                    <span className="spa-visually-hidden"> avant et après le soin</span>
                  </td>
                  {/* La durée réellement bloquée, tampons compris : c'est elle
                      qui explique pourquoi le créneau suivant n'est pas libre à
                      l'heure attendue. L'API la calcule ; le front ne la
                      recompose pas. */}
                  <td className="spa-admin-table__cell">{formatDuration(service.occupiedMinutes)}</td>
                  {/* Le montant arrive en entier de plus petite unité avec son
                      code devise, et n'est mis en forme qu'ici — le front n'en
                      fait jamais l'arithmétique. */}
                  <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                    {formatMoney(service.price)}
                  </td>
                  <td className="spa-admin-table__cell">
                    <CatalogStatusBadge isActive={service.isActive} />
                  </td>
                  {canManage ? (
                    <td className="spa-admin-table__cell">
                      <ServiceActivationButton tenantSlug={tenantSlug} service={service} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
