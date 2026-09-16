import { MY_APPOINTMENTS_DEFAULT_LIMIT } from '@spa/shared';
import Link from 'next/link';

import { fetchMyAppointments, fetchPublicServices } from '@/lib/api-client';

import { AppointmentList } from './components/appointment-list';
import { LogoutButton } from './components/logout-button';
import { accountPath } from './paths';
import { readAccountData } from './session';
import { accountTenant } from './tenant';

/**
 * L'accueil de l'espace client : les rendez-vous **à venir** et l'**historique**
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
 *
 * ## La coupure n'est pas temporelle, et les intitulés le disent (#744)
 *
 * `scope=past` n'est pas « ce qui est passé » : c'est le **complément exact** de
 * `scope=upcoming`, que l'API définit comme « l'intervalle n'est pas terminé
 * **et** le statut occupe encore le créneau » (`appointments.repository.ts`,
 * `listForClient`). Un rendez-vous annulé pour la semaine prochaine n'occupe
 * plus rien : il tombe donc dans la seconde moitié tout en étant daté du futur.
 * C'est voulu — les deux moitiés sont disjointes et complémentaires, si bien
 * qu'aucun rendez-vous ne peut disparaître de l'espace client.
 *
 * Intituler cette moitié « Rendez-vous passés » la faisait donc mentir sur son
 * propre contenu : le CDC §2.4 décrit le rendez-vous par un **statut** et un
 * **créneau** distincts, et un intitulé qui annonce un critère de créneau doit
 * être peuplé selon ce critère. La coupure réelle étant « encore actionnable »
 * contre « archivé », c'est elle qui est écrite — en titre pour la seconde
 * moitié, et en légende pour les deux, afin qu'une date future sous
 * « Historique » se lise comme une règle et non comme un bug.
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
        <div className="spa-account__section-heading">
          <h2 className="spa-account__section-title" id="rdv-a-venir">
            Rendez-vous à venir
          </h2>
          <p className="spa-account__section-hint">
            Ceux que vous pouvez encore reporter ou annuler.
          </p>
        </div>
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

      <section className="spa-account__section" aria-labelledby="historique">
        <div className="spa-account__section-heading">
          <h2 className="spa-account__section-title" id="historique">
            Historique
          </h2>
          <p className="spa-account__section-hint">
            Vos rendez-vous honorés, annulés ou déplacés — même lorsque leur date n’est pas encore
            passée.
          </p>
        </div>
        <AppointmentList
          tenantSlug={tenantSlug}
          appointments={past}
          timeZone={tenant.timezone}
          services={services}
          scope="past"
          emptyTitle="Votre historique est vide"
          // La légende au-dessus dit déjà ce que la section range : le vide n'a
          // plus qu'à dire **quand** il se remplira, sans la répéter mot pour mot.
          // « dès votre première visite » serait faux du même défaut que
          // « Rendez-vous passés » : un rendez-vous annulé ou déplacé remplit
          // cette moitié sans qu'aucune visite ait eu lieu. Le déclencheur est la
          // sortie de l'autre moitié, et c'est lui qui est écrit.
          emptyDescription="Il se remplira dès qu’un de vos rendez-vous quittera la liste « Rendez-vous à venir »."
        />
      </section>
    </>
  );
}
