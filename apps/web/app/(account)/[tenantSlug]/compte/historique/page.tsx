import { MY_APPOINTMENTS_DEFAULT_LIMIT } from '@spa/shared';
import Link from 'next/link';

import { EmptyState } from '@/components/ui/empty-state';
import { fetchMyAppointments, fetchPublicServices } from '@/lib/api-client';
import { isRenewalReturn, RENEWAL_PARAM } from '@/lib/session-refresh';

import { AppointmentList } from '../components/appointment-list';
import { accountPath, salonPath } from '../paths';
import { readAccountData } from '../session';
import { accountTenant } from '../tenant';

/**
 * L'onglet « Historique » de l'espace client — #1053.
 *
 * ## Pourquoi un écran à lui
 *
 * `BM-RDV-01` : « À venir d'abord, Passés à part ». Les deux moitiés étaient
 * empilées sur le même écran, et l'audit `d20260918-1` relève qu'à 360 px le
 * prochain rendez-vous se perdait sous neuf lignes d'archive. #1054 reprend la
 * présentation de cette liste — regroupement par mois, filtres, « Réserver à
 * nouveau » — et attend cet onglet pour le faire.
 *
 * ## Ce que cette moitié range, et pourquoi son titre ne parle pas du passé
 *
 * `scope=past` n'est pas « ce qui est passé » : c'est le **complément exact** de
 * `scope=upcoming`, que l'API définit comme « l'intervalle n'est pas terminé
 * **et** le statut occupe encore le créneau » (`appointments.repository.ts`,
 * `listForClient`). Un rendez-vous annulé pour la semaine prochaine n'occupe
 * plus rien : il tombe donc ici tout en étant daté du futur. Intituler cette
 * moitié « Rendez-vous passés » la ferait mentir sur son propre contenu (#744) —
 * « Historique » ne promet aucun critère de créneau, et c'est ce qui la rend
 * juste sans l'aide d'une légende.
 */

export const dynamic = 'force-dynamic';

interface HistoryPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  /** Le marqueur de renouvellement, comme sur l'onglet voisin — voir `(liste)/page.tsx`. */
  readonly searchParams?: Promise<{ readonly session?: string | readonly string[] }>;
}

export default async function AccountHistoryPage({ params, searchParams }: HistoryPageProps) {
  const { tenantSlug } = await params;
  const query = (await searchParams) ?? {};
  const here = accountPath(tenantSlug, '/historique');

  const [tenant, services, past] = await Promise.all([
    accountTenant(tenantSlug),
    fetchPublicServices(tenantSlug),
    readAccountData(
      tenantSlug,
      here,
      async (accessToken) =>
        fetchMyAppointments(accessToken, {
          scope: 'past',
          limit: MY_APPOINTMENTS_DEFAULT_LIMIT,
        }),
      isRenewalReturn(query[RENEWAL_PARAM]),
    ),
  ]);

  return (
    <section className="spa-account__section" aria-labelledby="historique">
      {/* Le titre double l'onglet actif juste au-dessus : masqué, il garde à la
          région son nom accessible sans écrire deux fois le même mot. */}
      <h2 className="spa-visually-hidden" id="historique">
        Historique
      </h2>

      {past.length === 0 ? (
        <EmptyState
          icon="clock"
          title="Votre historique est vide"
          action={
            // La vitrine et non le tunnel : l'historique se remplit d'un
            // rendez-vous, et un rendez-vous commence par le choix d'un soin.
            // Second rôle, donc `neutral` — l'accent appartient à l'onglet des
            // rendez-vous, qui commande le parcours (#745).
            <Link className="spa-button spa-button--neutral" href={salonPath(tenantSlug)}>
              <span className="spa-button__label">Découvrir les prestations</span>
            </Link>
          }
        >
          Il se remplira dès qu’un de vos rendez-vous quittera la liste « Mes rendez-vous ».
        </EmptyState>
      ) : (
        <AppointmentList
          tenantSlug={tenantSlug}
          appointments={past}
          timeZone={tenant.timezone}
          services={services}
          scope="past"
        />
      )}
    </section>
  );
}
