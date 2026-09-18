import type { BookedAppointment, PublicService } from '@spa/shared';
import { MY_APPOINTMENTS_DEFAULT_LIMIT } from '@spa/shared';
import Link from 'next/link';

import { appointmentBrief } from '@/components/account/appointment-brief';
import { SalonAside } from '@/components/account/salon-aside';
import { EmptyState } from '@/components/ui/empty-state';
import { fetchMyAppointments, fetchPublicServices } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';
import { isRenewalReturn, RENEWAL_PARAM } from '@/lib/session-refresh';

import { AppointmentHero } from '../components/appointment-hero';
import { AppointmentList } from '../components/appointment-list';
import { accountPath, bookingPath } from '../paths';
import { readAccountData } from '../session';
import { accountTenant } from '../tenant';

/**
 * L'onglet « Mes rendez-vous » de l'espace client : ce qu'il reste à honorer
 * (#47, deuxième critère ; CDC §1.4). L'historique a le sien depuis #1053.
 *
 * Server Component, et rendu à la demande : des rendez-vous se lisent connectée,
 * il n'y a rien à pré-rendre et rien à mettre en cache — deux visiteuses
 * partageraient l'espace de la première arrivée.
 *
 * ## Ce que cet écran montre, et dans quel ordre (#1053)
 *
 * `BM-RDV-01` — « À venir d'abord » — et l'audit `d20260918-1` : le prochain
 * rendez-vous doit être « la première chose visible à 360 px », et non une carte
 * parmi dix. L'écran s'ouvre donc sur **une** carte héros
 * (`AppointmentHero`) ; les rendez-vous suivants sont des cartes compactes sous
 * un titre qui les annonce pour ce qu'ils sont.
 *
 * Aucun paragraphe d'explication sous un titre de section : les quatre lignes
 * qui précédaient la liste tiennent désormais en une ligne, sous la pastille du
 * rendez-vous qu'elles concernent (`AppointmentCard`).
 *
 * ## La seconde moitié n'est plus chargée pour rien
 *
 * L'écran demandait les deux moitiés à chaque visite. L'historique ayant son
 * onglet, seule « à venir » est lue ici — **sauf** quand elle est vide : l'état
 * vide nomme alors la dernière prestation honorée, ce que `BM-HISTO-02` demande
 * de proposer. La seconde lecture ne part donc que dans le cas où elle sert, et
 * dans le seul cas où l'écran n'a rien d'autre à afficher.
 */

export const dynamic = 'force-dynamic';

interface AccountPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  /**
   * Cet écran n'a qu'un paramètre d'URL, et il ne l'écrit pas lui-même : le
   * marqueur de renouvellement, posé par la route de renouvellement au retour
   * d'un 401 (#861). Sans lui, la garde retenterait un renouvellement à chaque
   * rendu et une API qui refuse jusqu'aux jetons qu'elle vient d'émettre
   * enchaînerait les redirections jusqu'à la page d'erreur du navigateur.
   *
   * Facultatif parce que Next le passe toujours et que les doubles de test, eux,
   * ne le passent pas : l'exiger ferait échouer sur un `undefined` des rendus que
   * l'application ne produit jamais.
   */
  readonly searchParams?: Promise<{ readonly session?: string | readonly string[] }>;
}

export default async function AccountPage({ params, searchParams }: AccountPageProps) {
  const { tenantSlug } = await params;
  const query = (await searchParams) ?? {};
  const here = accountPath(tenantSlug);

  const [tenant, services, appointments] = await Promise.all([
    accountTenant(tenantSlug),
    fetchPublicServices(tenantSlug),
    readAccountData(
      tenantSlug,
      here,
      async (accessToken) => {
        const upcoming = await fetchMyAppointments(accessToken, {
          scope: 'upcoming',
          limit: MY_APPOINTMENTS_DEFAULT_LIMIT,
        });

        // Voir l'en-tête : la seconde lecture ne sert qu'à nommer la dernière
        // prestation honorée dans l'état vide.
        const past =
          upcoming.length > 0
            ? []
            : await fetchMyAppointments(accessToken, {
                scope: 'past',
                limit: MY_APPOINTMENTS_DEFAULT_LIMIT,
              });

        return { upcoming, past };
      },
      // Le marqueur de renouvellement, s'il est là : c'est ce qui borne la
      // tentative à une seule et empêche la chaîne de redirections (#861).
      isRenewalReturn(query[RENEWAL_PARAM]),
    ),
  ]);

  const [next, ...others] = appointments.upcoming;

  return (
    <div className="spa-account__columns">
      <section className="spa-account__section" aria-labelledby="rdv-a-venir">
        {/* Le titre de la section double l'onglet actif, qui dit déjà « Mes
            rendez-vous » juste au-dessus : l'écrire une seconde fois en clair
            serait le mur de texte que l'audit relève. Masqué, il garde à la
            région son nom accessible (WCAG 1.3.1). */}
        <h2 className="spa-visually-hidden" id="rdv-a-venir">
          Rendez-vous à venir
        </h2>

        {next === undefined ? (
          <AucunRendezVous tenantSlug={tenantSlug} past={appointments.past} services={services} />
        ) : (
          <>
            <AppointmentHero
              tenantSlug={tenantSlug}
              brief={appointmentBrief(next, services)}
              tenant={tenant}
              timeZone={tenant.timezone}
            />

            {others.length === 0 ? null : (
              <section className="spa-account__section" aria-labelledby="rdv-suivants">
                <h3 className="spa-account__section-title" id="rdv-suivants">
                  Ensuite
                </h3>
                <AppointmentList
                  tenantSlug={tenantSlug}
                  appointments={others}
                  timeZone={tenant.timezone}
                  services={services}
                  scope="upcoming"
                />
              </section>
            )}
          </>
        )}
      </section>

      <SalonAside tenant={tenant} />
    </div>
  );
}

interface AucunRendezVousProps {
  readonly tenantSlug: string;
  readonly past: readonly BookedAppointment[];
  readonly services: readonly PublicService[];
}

/**
 * L'état vide de l'onglet — le seul moment où cet écran n'a rien à montrer.
 *
 * `docs/design/appointments/states.md` § « Règles générales » veut « une
 * explication **et au moins une action** » : le bouton primaire mène au tunnel,
 * qui est la sortie de cet écran (#745).
 *
 * `BM-HISTO-02` veut en plus que la cliente puisse « refaire la même prestation
 * sans refaire tout le tunnel ». La dernière prestation honorée est donc
 * **nommée** ici. Elle n'est pas encore pré-sélectionnée : le tunnel n'accepte
 * aucun paramètre d'URL aujourd'hui, et lui en ajouter un appartient à son
 * propre chantier. Nommer sans pré-remplir reste tenable — la phrase rappelle
 * quoi rechoisir —, promettre « en un clic » ne l'aurait pas été.
 */
function AucunRendezVous({ tenantSlug, past, services }: AucunRendezVousProps) {
  const derniere = past.find((appointment) => appointment.status === 'completed') ?? null;
  const brief = derniere === null ? null : appointmentBrief(derniere, services);

  return (
    <EmptyState
      icon="calendar"
      title="Aucun rendez-vous à venir"
      action={
        // Un lien et non un bouton : c'est une **destination**, elle s'ouvre
        // dans un onglet et se copie.
        <Link className="spa-button spa-button--accent" href={bookingPath(tenantSlug)}>
          <span className="spa-button__label">Prendre rendez-vous</span>
        </Link>
      }
    >
      {brief === null || brief.serviceName === null ? (
        'Choisissez une prestation et un créneau pour réserver votre prochaine visite.'
      ) : (
        <>
          Votre dernière visite : {brief.serviceName} · {formatDuration(brief.durationMinutes)}
          {brief.practitioner === null ? null : <> · {brief.practitioner}</>}.
        </>
      )}
    </EmptyState>
  );
}
