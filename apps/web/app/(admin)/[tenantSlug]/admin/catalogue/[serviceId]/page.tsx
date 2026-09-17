import {
  hasAtLeastRole,
  uuidSchema,
  type Service,
  type ServiceCategory,
  type ServiceStaffMember,
  type SessionUser,
  type StaffMember,
} from '@spa/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';

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
import {
  ServiceStaffPanel,
  type ServiceStaffChoice,
} from '../../components/service-staff-panel';
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
 * Depuis #768 elle n'est plus amputée des praticiens **déjà** affectés : le
 * panneau liste tout l'établissement et bascule chaque ligne, comme la fiche
 * praticien liste tout le catalogue. C'est le même lien (CDC §2.4), vu des deux
 * bouts ; il n'avait aucune raison de s'éditer de deux façons.
 *
 * ## Le rang qui écrit n'est pas celui qui ouvre la fiche
 *
 * `GET /v1/services/{id}` se lit dès le rang praticien ; l'enregistrement du
 * formulaire et l'affectation d'un praticien sont, eux, `@AuthAtLeast('MANAGER')`.
 * Le profil est donc lu ici et descendu aux deux panneaux, qui rendent la fiche
 * en lecture seule plutôt que de faire découvrir le refus à la soumission
 * (#619).
 *
 * ## Les trois façons de ne pas trouver la prestation n'en font qu'une
 *
 * Identifiant mal formé, identifiant inconnu, prestation d'un autre
 * établissement : les trois se répondent `notFound()`, indistinctement
 * (tenant-isolation §4), et `not-found.tsx` — la frontière posée au même segment
 * par #697 — en rend l'encart dans l'enveloppe du back-office, avec son lien de
 * retour vers le catalogue.
 *
 * Cette page rendait auparavant l'encart elle-même, et pour le seul 404 : elle
 * répondait donc **200** sur une prestation inexistante, et laissait le 400 du
 * `ParseUUIDPipe` tomber dans la branche par défaut d'`adminLoadFailure`.
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

  /*
   * Un identifiant mal formé ne désigne aucune prestation : il se refuse ici,
   * avant le moindre aller-retour (#697).
   *
   * Sans ce contrôle, `pas-un-uuid` partait jusqu'à `GET /v1/services/:id` et
   * `GET /v1/services/:id/staff`, dont le `ParseUUIDPipe` rend **400**. Ce statut
   * n'est ni un 404 ni un refus de rôle : il tombait dans la branche par défaut
   * d'`adminLoadFailure`, qui affiche `error.message` tel quel — et, quand le
   * jeton d'accès expirait dans la même seconde, l'écran de connexion vide que la
   * campagne de QA a relevé sur une session valide.
   *
   * Le refus vient **après** la garde, et non avant : l'écran d'introuvable est
   * celui du back-office, et une visiteuse sans session doit voir la connexion,
   * pas un 404 qui lui apprendrait la forme des identifiants du salon.
   *
   * `uuidSchema` est la v4 stricte du contrat partagé — la même que celle dont
   * l'API tire tous ses identifiants (`@default(uuid())`) : refuser ici ce
   * qu'elle refuse là-bas ne coûte qu'un refus plus tôt, du bon côté de l'écran.
   * Même garde-fou, mêmes mots, que la fiche praticien (#696).
   */
  if (!uuidSchema.safeParse(serviceId).success) {
    notFound();
  }

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
    // n'a pas à le faire non plus (tenant-isolation §4). Il rejoint désormais le
    // refus d'identifiant hors contrat sur `not-found.tsx`, au lieu d'un encart
    // rendu ici sous un statut 200.
    //
    // `notFound()` lève : l'appeler depuis ce `catch` est sans risque, rien ne
    // l'entoure qui pourrait avaler la navigation — c'est déjà ainsi que le 401
    // d'`adminLoadFailure` part à la connexion.
    if (error instanceof ApiClientError && error.status === 404) {
      notFound();
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

  /*
   * L'annuaire tout entier, chaque fiche portant son état vis-à-vis de cette
   * prestation (#768) — et non plus les seuls non affectés.
   *
   * Le filet : une affectation dont la fiche ne figure pas dans l'annuaire est
   * ajoutée à la liste. Les deux lectures portent le même établissement et le
   * cas ne devrait pas se produire ; s'il se produisait, la ligne manquante
   * serait une affectation invisible — donc impossible à retirer depuis l'écran
   * qui la gère.
   */
  const directory = new Map(staff.map((member) => [member.id, member]));
  for (const member of assigned) {
    if (!directory.has(member.id)) {
      directory.set(member.id, {
        id: member.id,
        displayName: member.displayName,
        isActive: member.isActive,
      });
    }
  }

  const roster: ServiceStaffChoice[] = sortStaffMembers([...directory.values()]).map((member) => ({
    id: member.id,
    displayName: member.displayName,
    isActive: member.isActive,
    assigned: affected.has(member.id),
  }));
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

      {/* Plus de `spa-admin__split` ici (#768) : sa première colonne est bornée
       * à 22 rem, et le panneau des praticiens n'y listait que les non affectés
       * — une liste courte par construction. Il liste désormais l'établissement
       * entier, et une liste longue dans une colonne étroite est précisément ce
       * que la fiche praticien avait déjà refusé pour sa semaine d'horaires. Les
       * sections s'empilent donc sur toute la largeur, dans l'ordre où on les
       * remplit : la prestation, puis qui la pratique. La longueur du panneau ne
       * pousse plus rien vers le bas, puisqu'il est dernier.
       *
       * Le conteneur borne le formulaire à la mesure de saisie du produit, la
       * même qu'à la création : sans lui il prendrait les 1 900 px de la zone de
       * contenu pour des champs de durée et de prix (#630). */}
      <div className="spa-admin-form">
        <ServiceForm
          tenantSlug={tenantSlug}
          currency={service.price.currency}
          categories={categories}
          service={service}
          canManage={canManage}
        />
      </div>

      <ServiceStaffPanel
        tenantSlug={tenantSlug}
        serviceId={service.id}
        staff={roster}
        canManage={canManage}
      />
    </section>
  );
}
