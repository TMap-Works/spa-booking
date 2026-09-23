import { hasAtLeastRole, type Locale, type Service, type SessionUser } from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { fetchOwnProfile, fetchServices } from '@/lib/api-client';
import { formatDuration, formatMoney } from '@/lib/format';

import { CatalogStatusBadge } from '../../components/catalog-status-badge';
import { ServiceActivationButton } from '../../components/service-activation-button';
import { ServiceBookabilityBadge } from '../../components/service-bookability-badge';
import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import {
  adminCatalogPath,
  adminCatalogPreviewPath,
  adminNewServicePath,
  adminServiceCategoriesPath,
  adminServicePath,
} from '../../paths';

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
 *
 * ## Pourquoi sous `(liste)/` (#830)
 *
 * Le groupe ne change pas l'URL. Il donne à la liste un dossier où poser son
 * squelette (`loading.tsx`) sans envelopper la fiche voisine, dont le 404 doit
 * partir avant tout squelette — voir `components/admin-screen-skeleton.tsx`.
 *
 * ## « Active » ne veut pas dire « réservable » (#885)
 *
 * Une prestation qu'aucun praticien ne pratique n'offre aucun créneau, active ou
 * non — le moteur de disponibilité part des affectations. La colonne « État »
 * portait jusqu'ici la seule activité, si bien qu'il fallait ouvrir chaque fiche
 * pour distinguer une prestation réservable d'une prestation qui ne le sera
 * jamais. Le second badge dit la condition là où l'œil la cherche.
 *
 * Trois points tenus, et chacun a sa raison :
 *
 * - **les comptes viennent de l'API** (`GET /v1/services`), et le front ne les
 *   recompose pas. Les déduire du point d'entrée public ne dirait rien des
 *   prestations désactivées, que le catalogue public ne publie pas et que cette
 *   liste montre pourtant ;
 * - **le libellé est celui de la vitrine**, importé et non recopié : trois écrans
 *   qui nomment le même état de trois façons, c'est l'écart `ds:coherence` que ce
 *   ticket referme, pas un qu'il rouvre ;
 * - **le signal est écrit**, pas seulement coloré (WCAG 1.4.1) — c'est la règle
 *   que `CatalogStatusBadge` suit déjà.
 *
 * ## Deux comptes, parce que deux questions (#895)
 *
 * `assignedStaffCount` compte les praticiens affectés, désactivés compris — c'est
 * ce que montre la fiche, et #885 a posé que la liste ne devait pas la contredire.
 * Le badge, lui, ne se fonde pas dessus : il se fonde sur
 * `activeAssignedStaffCount`, parce que la question qu'il pose est celle de la
 * vitrine — « peut-on en réserver un créneau ». Une prestation dont le seul
 * praticien affecté a été désactivé vaut `1` et `0` : la liste se taisait, quand
 * l'aperçu public l'annonçait injoignable.
 *
 * C'est `ServiceBookabilityBadge` qui tranche entre les deux libellés — « aucun
 * praticien affecté » et « aucun praticien actif » —, parce que les deux causes
 * appellent deux gestes différents : affecter quelqu'un, ou réactiver un compte.
 *
 * Le badge s'affiche quel que soit l'état d'activité, comme la fiche affiche
 * « Aucun praticien affecté » sans regarder `isActive` : une prestation désactivée
 * que personne ne peut honorer n'offrira rien de plus le jour où on la réactive, et
 * c'est utile de l'apprendre avant.
 *
 * ## Un en-tête dit ce que sa valeur mesure (#776)
 *
 * Deux colonnes sur huit se taisaient. « Tampons » coiffait « 10 / 15 min » sans
 * dire lequel des deux nombres précède le soin, et « Agenda » coiffait « 1 h 25 »
 * sans dire qu'il s'agit du temps réellement bloqué. Ni l'un ni l'autre ne se
 * devine : un lecteur qui hésite entre « 10 avant » et « 10 après » se trompe une
 * fois sur deux, et « Agenda » pouvait tout aussi bien annoncer une date.
 *
 * Les deux libellés sont repris **d'ailleurs**, pas inventés ici — c'est ce qui
 * les rend justes :
 *
 * - « Tampons avant / après » est le vocabulaire du formulaire de prestation,
 *   « Tampon avant (minutes) » et « Tampon après (minutes) » (`ServiceForm`), et
 *   son ordre est celui des deux nombres de la cellule ;
 * - « Durée bloquée » est ce que la fiche de la même prestation écrit déjà en
 *   toutes lettres — « Bloque 1 h 25 sur l'agenda, tampons compris. » La liste qui
 *   ouvre cette fiche ne peut pas le nommer autrement.
 *
 * La mention `spa-visually-hidden` « avant et après le soin » disparaît du même
 * geste, et ce n'est pas une perte pour les lecteurs d'écran : l'en-tête est lié à
 * sa cellule par `scope="col"` et se restitue avec elle. L'information change de
 * porteur, elle ne s'efface pas — et elle cesse d'être réservée à une partie des
 * lecteurs, ce qui était l'écart relevé.
 */

/**
 * Ce que dit l'écran vide, selon le filtre **et** selon ce que le rôle peut
 * faire : inviter une praticienne à créer une prestation, c'est lui proposer
 * exactement le geste que l'API refusera.
 *
 * La fonction ne rend plus la phrase mais sa **clé** (#849) : les quatre textes
 * vivent au catalogue `admin-catalog`, et c'est l'appelant qui les lit dans la
 * langue de la requête. L'arbre de décision, lui, n'a pas bougé.
 *
 * Le type de retour est l'**union des quatre clés** et non `string` : c'est ce
 * qui laisse `tsc` vérifier qu'elles existent au catalogue, comme il le ferait
 * d'un `t('…')` écrit sur place.
 */
type EmptyCatalogKey =
  | 'list.empty.activeManager'
  | 'list.empty.activeReader'
  | 'list.empty.manager'
  | 'list.empty.reader';

function emptyCatalogDescriptionKey(activeOnly: boolean, canManage: boolean): EmptyCatalogKey {
  if (activeOnly) {
    return canManage ? 'list.empty.activeManager' : 'list.empty.activeReader';
  }

  return canManage ? 'list.empty.manager' : 'list.empty.reader';
}

export const dynamic = 'force-dynamic';

interface CatalogPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<{ readonly actives?: string }>;
}

export default async function CatalogPage({ params, searchParams }: CatalogPageProps) {
  const { tenantSlug } = await params;
  const { actives } = await searchParams;
  const t = await getTranslations('admin-catalog');
  /*
   * La langue de la mise en forme des durées et des montants (#849).
   *
   * Sans `countryCode` : c'est exactement ce que fait le catalogue **public**
   * (`components/salon/service-catalog.tsx`), et les deux écrans doivent
   * annoncer le même prix. `lib/format.ts` retombe alors sur la région figée de
   * la langue — `fr` → `fr-FR`, `en` → `en-US` —, et la lecture du pays de
   * l'établissement n'appartient à aucun des deux : elle coûterait un
   * aller-retour de plus à une liste qui n'en fait que deux.
   */
  const display = { locale: (await getLocale()) as Locale };
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
      deniedTitle: t('denied.title'),
      deniedHint: t('denied.list'),
      failedTitle: t('failure.list'),
    });
  }

  const canManage = hasAtLeastRole(profile.role, 'manager');

  return (
    <section aria-labelledby="catalogue-titre">
      <h1 className="spa-admin__title" id="catalogue-titre">
        {t('list.title')}
      </h1>

      <div className="spa-admin-toolbar">
        <div className="spa-admin-toolbar__group">
          <Link
            className="spa-button spa-button--quiet"
            href={adminCatalogPath(tenantSlug)}
            aria-current={activeOnly ? undefined : 'page'}
          >
            {t('list.filters.all')}
          </Link>
          <Link
            className="spa-button spa-button--quiet"
            href={adminCatalogPath(tenantSlug, { activeOnly: true })}
            aria-current={activeOnly ? 'page' : undefined}
          >
            {t('list.filters.activeOnly')}
          </Link>
        </div>
        <span className="spa-admin-toolbar__spacer" />
        <div className="spa-admin-toolbar__group">
          <Link className="spa-button spa-button--neutral" href={adminServiceCategoriesPath(tenantSlug)}>
            {t('list.toolbar.categories')}
          </Link>
          <Link className="spa-button spa-button--neutral" href={adminCatalogPreviewPath(tenantSlug)}>
            {t('list.toolbar.preview')}
          </Link>
          {canManage ? (
            <Link className="spa-button spa-button--accent" href={adminNewServicePath(tenantSlug)}>
              {t('list.toolbar.newService')}
            </Link>
          ) : (
            <span className="spa-admin-toolbar__hint">{t('list.toolbar.restricted')}</span>
          )}
        </div>
      </div>

      {services.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">
            {activeOnly ? t('list.empty.activeTitle') : t('list.empty.title')}
          </p>
          <p className="spa-empty-state__description">
            {t(emptyCatalogDescriptionKey(activeOnly, canManage))}
          </p>
        </div>
      ) : (
        <div className="spa-admin__section">
          <table className="spa-admin-table">
            <caption className="spa-visually-hidden">
              {activeOnly ? t('list.caption.activeOnly') : t('list.caption.all')}
            </caption>
            <thead>
              <tr>
                <th className="spa-admin-table__head" scope="col">
                  {t('list.columns.service')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('list.columns.category')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('list.columns.duration')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('list.columns.buffers')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('list.columns.occupied')}
                </th>
                <th className="spa-admin-table__head spa-admin-table__head--numeric" scope="col">
                  {t('list.columns.price')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('list.columns.state')}
                </th>
                {canManage ? (
                  <th className="spa-admin-table__head" scope="col">
                    {t('list.columns.actions')}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr className="spa-admin-table__row" key={service.id}>
                  {/* Le nom et le nom de la rubrique sont la saisie du salon :
                      ils ne se traduisent pas. Seul le « Non classée » d'une
                      prestation sans rubrique est un mot du produit (#849). */}
                  <td className="spa-admin-table__cell">
                    <Link href={adminServicePath(tenantSlug, service.id)}>{service.name}</Link>
                  </td>
                  <td className="spa-admin-table__cell">
                    {service.category?.name ?? t('list.unclassified')}
                  </td>
                  <td className="spa-admin-table__cell">
                    {formatDuration(service.durationMinutes, display)}
                  </td>
                  {/* L'ordre des deux nombres est celui de l'en-tête, et plus
                      aucune mention n'est réservée aux seuls lecteurs d'écran :
                      « Tampons avant / après » le dit à tout le monde (#776).
                      L'unité vient du catalogue plutôt que du JSX : « min »
                      s'abrège autrement d'une langue à l'autre. */}
                  <td className="spa-admin-table__cell">
                    {t('list.buffers', {
                      before: service.bufferBeforeMinutes,
                      after: service.bufferAfterMinutes,
                    })}
                  </td>
                  {/* La durée réellement bloquée, tampons compris : c'est elle
                      qui explique pourquoi le créneau suivant n'est pas libre à
                      l'heure attendue. L'API la calcule ; le front ne la
                      recompose pas. */}
                  <td className="spa-admin-table__cell">
                    {formatDuration(service.occupiedMinutes, display)}
                  </td>
                  {/* Le montant arrive en entier de plus petite unité avec son
                      code devise, et n'est mis en forme qu'ici — le front n'en
                      fait jamais l'arithmétique. Seule sa mise en forme suit la
                      langue. */}
                  <td className="spa-admin-table__cell spa-admin-table__cell--numeric">
                    {formatMoney(service.price, display)}
                  </td>
                  <td className="spa-admin-table__cell">
                    <CatalogStatusBadge isActive={service.isActive} />
                    {/* Le second badge dit la réservabilité — nul si la
                        prestation en a une —, et porte lui-même l'espace qui le
                        sépare du premier : les deux peuvent alors passer à la
                        ligne quand la colonne se resserre, là où un
                        `white-space: nowrap` commun les aurait poussés hors du
                        conteneur qui défile (#612). */}
                    <ServiceBookabilityBadge
                      assignedStaffCount={service.assignedStaffCount}
                      activeAssignedStaffCount={service.activeAssignedStaffCount}
                    />
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
