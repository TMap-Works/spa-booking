import { MY_APPOINTMENTS_DEFAULT_LIMIT } from '@spa/shared';
import Link from 'next/link';

import { fetchMyAppointments, fetchPublicServices } from '@/lib/api-client';

import { AppointmentList } from './components/appointment-list';
import { LogoutButton } from './components/logout-button';
import { accountPath } from './paths';
import { readAccountData } from './session';
import { accountTenant } from './tenant';

/**
 * L'accueil de l'espace client : les rendez-vous **à venir** et les **passés**
 * (#47, deuxième critère ; CDC §1.4).
 *
 * Server Component, et rendu à la demande : un historique se lit connecté, il
 * n'y a rien à pré-rendre et rien à mettre en cache — deux visiteuses
 * partageraient l'historique de la première arrivée.
 *
 * ## Deux appels et non un
 *
 * L'API sert une moitié à la fois (`?scope=`), parce que les deux n'ont ni le
 * même ordre ni la même borne : « à venir » se lit du plus proche au plus
 * lointain, l'historique du plus récent au plus ancien. Les deux lectures
 * partent en parallèle — elles ne dépendent pas l'une de l'autre, et les
 * enchaîner doublerait le temps d'affichage pour rien.
 */

export const dynamic = 'force-dynamic';

interface AccountPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function AccountPage({ params }: AccountPageProps) {
  const { tenantSlug } = await params;
  const here = accountPath(tenantSlug);

  const [tenant, services, appointments] = await Promise.all([
    accountTenant(tenantSlug),
    fetchPublicServices(tenantSlug),
    readAccountData(tenantSlug, here, async (accessToken) =>
      Promise.all([
        fetchMyAppointments(accessToken, {
          scope: 'upcoming',
          limit: MY_APPOINTMENTS_DEFAULT_LIMIT,
        }),
        fetchMyAppointments(accessToken, { scope: 'past', limit: MY_APPOINTMENTS_DEFAULT_LIMIT }),
      ]),
    ),
  ]);

  const [upcoming, past] = appointments;

  return (
    <>
      <nav className="spa-account__nav" aria-label="Mon compte">
        <Link className="spa-account__nav-link" href={accountPath(tenantSlug, '/coordonnees')}>
          Modifier mes coordonnées
        </Link>
        <LogoutButton tenantSlug={tenantSlug} />
      </nav>

      <section className="spa-account__section" aria-labelledby="rdv-a-venir">
        <h2 className="spa-account__section-title" id="rdv-a-venir">
          Rendez-vous à venir
        </h2>
        <AppointmentList
          tenantSlug={tenantSlug}
          appointments={upcoming}
          timeZone={tenant.timezone}
          services={services}
          scope="upcoming"
          emptyTitle="Aucun rendez-vous à venir"
          emptyDescription="Choisissez une prestation et un créneau pour réserver votre prochaine visite."
        />
      </section>

      <section className="spa-account__section" aria-labelledby="rdv-passes">
        <h2 className="spa-account__section-title" id="rdv-passes">
          Rendez-vous passés
        </h2>
        <AppointmentList
          tenantSlug={tenantSlug}
          appointments={past}
          timeZone={tenant.timezone}
          services={services}
          scope="past"
          emptyTitle="Aucune visite pour le moment"
          emptyDescription="Vos rendez-vous honorés, annulés et déplacés apparaîtront ici."
        />
      </section>
    </>
  );
}
