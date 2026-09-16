import { MY_APPOINTMENTS_DEFAULT_LIMIT } from '@spa/shared';

import { fetchMyAppointments, fetchPublicServices } from '@/lib/api-client';

import { AppointmentList } from './components/appointment-list';
import { accountPath, bookingPath, salonPath } from './paths';
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
 *
 * ## Les deux vides de la première visite portent chacun leur sortie (#745)
 *
 * Un compte créé à l'instant affiche les deux moitiés vides à la fois, et c'est
 * le seul moment où cet écran n'a rien à montrer. `states.md` § « Règles
 * générales » veut alors « une explication **et au moins une action** » : les
 * deux phrases étaient là, aucune action ne l'était — à 360 px le seul chemin
 * était un lien de pied de page situé **sous** les deux blocs.
 *
 * Les deux sorties sont distinctes à dessein, plutôt que deux exemplaires du
 * même bouton empilés :
 *
 * | Moitié vide | Sortie | Pourquoi celle-là |
 * |---|---|---|
 * | Rendez-vous à venir | **Prendre rendez-vous** → tunnel | l'action que la phrase appelle déjà ; c'est la sortie principale de l'écran, donc l'accent |
 * | Historique | Découvrir les prestations → vitrine | on n'archive rien sans avoir d'abord choisi un soin ; second rôle, donc `neutral` |
 *
 * Une seule action porte l'accent : deux boutons primaires côte à côte ne
 * hiérarchisent plus rien, et c'est le bloc « à venir » qui commande l'écran.
 *
 * ## Ce que cet écran ne rend plus : la navigation du compte (#747)
 *
 * « Modifier mes coordonnées | Se déconnecter » était rendue ici, et donc nulle
 * part ailleurs : les coordonnées et le report n'offraient aucun moyen de fermer
 * sa session. Ce qui appartient à l'espace et non à un écran est passé au
 * gabarit (`layout.tsx`, `components/account-nav.tsx`). Cette page ne rend plus
 * que ses deux moitiés — ce qui lui est propre.
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
          emptyAction={{
            href: bookingPath(tenantSlug),
            label: 'Prendre rendez-vous',
            variant: 'accent',
          }}
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
          // La vitrine et non le tunnel : l'historique se remplit d'un
          // rendez-vous, et un rendez-vous commence par le choix d'un soin. Le
          // catalogue et ses tarifs sont là, et le bouton « Réserver » de la
          // vitrine rejoint le tunnel — la sortie est réelle sans répéter mot
          // pour mot le bouton primaire posé juste au-dessus.
          emptyAction={{
            href: salonPath(tenantSlug),
            label: 'Découvrir les prestations',
            variant: 'neutral',
          }}
        />
      </section>
    </>
  );
}
