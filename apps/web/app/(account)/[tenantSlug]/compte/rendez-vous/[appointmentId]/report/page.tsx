import { MAX_AVAILABILITY_RANGE_DAYS, MY_APPOINTMENTS_MAX_LIMIT, uuidSchema } from '@spa/shared';
import { notFound } from 'next/navigation';

import { addCalendarDays, calendarDateInTimeZone } from '@/lib/booking/calendar';
import { fetchAvailability, fetchMyAppointments, fetchPublicServices } from '@/lib/api-client';

import { RescheduleForm } from '../../../components/reschedule-form';
import { accountPath } from '../../../paths';
import { readAccountData } from '../../../session';
import { accountTenant } from '../../../tenant';

/**
 * Report d'un rendez-vous depuis l'espace client (#47, troisième critère).
 *
 * ## Le rendez-vous est retrouvé dans l'historique, jamais lu par identifiant
 *
 * Il n'existe pas de `GET /appointments/:id` — et il n'en faut pas un pour cet
 * écran. La liste « à venir » est déjà bornée à la cliente du jeton et à son
 * établissement : y chercher l'identifiant demandé rend impossible, par
 * construction, d'ouvrir cet écran sur le rendez-vous de quelqu'un d'autre. Un
 * identifiant absent de cette liste rend **404**, qu'il désigne un rendez-vous
 * inexistant, celui d'une autre cliente, ou l'un des siens déjà passé — les
 * trois doivent être indiscernables (tenant-isolation §4).
 *
 * Ce 404-là est rendu par `not-found.tsx`, posé à côté de cette page (#627) :
 * sans lui, l'appel remontait jusqu'au 404 des adresses publiques, qui renvoie la
 * cliente vers « le lien que le salon vous a communiqué » — alors qu'elle est
 * dans son propre espace — et qui ne porte aucun lien de retour.
 *
 * ## La fenêtre de créneaux part d'aujourd'hui, dans le fuseau du salon
 *
 * Une date civile n'est pas un instant : « aujourd'hui » n'est pas la même
 * journée à Antananarivo et à Papeete. La borne se calcule donc avec le fuseau de
 * l'établissement, comme dans le tunnel.
 *
 * ## Le rendez-vous déplacé ne s'occupe pas lui-même (#442)
 *
 * C'est le seul écran du produit qui interroge le calendrier **en sachant qu'un
 * rendez-vous va disparaître**. Sans le dire, il se voit refuser tous les
 * créneaux qui chevauchent celui qu'il déplace : un soin d'une heure ne peut plus
 * bouger de moins d'une heure, alors que c'est le report le plus courant. La
 * réponse à cette question-là n'est vraie que pour cette cliente et pour ce
 * geste, et l'API l'écarte donc de son cache — voir le README du module
 * `availability`.
 *
 * ## … et elle s'élargit sur demande (#738)
 *
 * `states.md` étape 3 prescrit « Voir plus de jours » partout où le sélecteur
 * est rendu, et cet écran n'y échappait pas : la bande listait quinze dates et
 * s'arrêtait, sans la moindre commande pour aller au-delà. L'élargissement passe
 * par l'adresse et non par un état de composant, parce que c'est le serveur qui
 * lit le calendrier — voir `WIDE_WINDOW_PARAM`.
 */

export const dynamic = 'force-dynamic';

/**
 * Profondeur de la fenêtre proposée, en journées civiles.
 *
 * Quatorze plutôt que les trente et un que l'API tolère : c'est l'horizon sur
 * lequel une cliente déplace réellement un rendez-vous, et une fenêtre plus large
 * ferait scruter au moteur de disponibilité un mois d'agenda pour des créneaux
 * que personne ne fait défiler.
 */
const RESCHEDULE_WINDOW_DAYS = 14;

/**
 * La profondeur qu'ouvre « Voir plus de jours » — la borne du contrat, pas une
 * journée de plus.
 *
 * `- 1` n'est pas une marge de sécurité : `calendarDaysBetween` compte **les
 * deux bornes**, si bien qu'un `to` posé à `from + 31` demande trente-deux
 * journées et se fait refuser par `availabilityQuerySchema`. Le tunnel demande
 * la même profondeur, et la calcule de la même façon.
 */
const WIDE_WINDOW_DAYS = MAX_AVAILABILITY_RANGE_DAYS - 1;

/**
 * Ce que le paramètre porte : le nombre de journées **affichées**, bornes
 * comprises — ce que la visiteuse lit dans son adresse, et non l'écart interne
 * qui sépare les deux bornes de la requête.
 */
const WIDE_WINDOW_VALUE = String(MAX_AVAILABILITY_RANGE_DAYS);

/**
 * Le paramètre par lequel l'écran retient une fenêtre élargie.
 *
 * Dans l'adresse et non dans un état de composant : cette page est rendue par le
 * serveur, c'est lui qui lit le calendrier, et c'est donc lui qu'il faut
 * reposer la question. Le passer par l'URL a de surcroît le mérite de survivre
 * au rafraîchissement et de se partager — un `useState` aurait renvoyé la
 * visiteuse à quatorze jours au premier F5.
 */
const WIDE_WINDOW_PARAM = 'jours';

interface ReschedulePageProps {
  readonly params: Promise<{
    readonly tenantSlug: string;
    readonly appointmentId: string;
  }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReschedulePage({ params, searchParams }: ReschedulePageProps) {
  const { tenantSlug, appointmentId } = await params;
  const query = await searchParams;

  /**
   * Fenêtre élargie ou non — et rien entre les deux.
   *
   * Une égalité stricte à la seule valeur qu'on écrit soi-même, plutôt qu'un
   * entier analysé puis borné : le paramètre vient de l'adresse, donc du
   * visiteur, et l'API refuserait une plage hors contrat par un 400 que cet
   * écran rendrait en page d'erreur. Tout ce qui n'est pas la valeur attendue
   * retombe donc sur la fenêtre par défaut.
   */
  const wide = query[WIDE_WINDOW_PARAM] === WIDE_WINDOW_VALUE;

  const id = uuidSchema.safeParse(appointmentId);
  if (!id.success) {
    // Un identifiant mal formé ne désigne aucun rendez-vous : inutile d'ouvrir
    // une session pour le constater.
    notFound();
  }

  const here = accountPath(tenantSlug, `/rendez-vous/${id.data}/report`);

  const [tenant, services, upcoming] = await Promise.all([
    accountTenant(tenantSlug),
    fetchPublicServices(tenantSlug),
    readAccountData(tenantSlug, here, async (accessToken) =>
      fetchMyAppointments(accessToken, { scope: 'upcoming', limit: MY_APPOINTMENTS_MAX_LIMIT }),
    ),
  ]);

  const appointment = upcoming.find((candidate) => candidate.id === id.data);
  if (appointment === undefined) {
    notFound();
  }

  const from = calendarDateInTimeZone(new Date(), tenant.timezone);

  const availability = await fetchAvailability(tenantSlug, {
    serviceId: appointment.serviceId,
    // Le même praticien : reporter ne change pas de praticien de lui-même, cela
    // déplacerait une cliente chez quelqu'un qu'elle n'a pas choisi.
    staffId: appointment.staffId,
    from,
    to: addCalendarDays(from, wide ? WIDE_WINDOW_DAYS : RESCHEDULE_WINDOW_DAYS),
    // Le rendez-vous en cours de déplacement n'a pas à se barrer la route : c'est
    // lui qu'on libère. Sans cette exclusion, un soin d'une heure ne pourrait
    // jamais être décalé de moins d'une heure.
    excludeAppointmentId: appointment.id,
  });

  return (
    <RescheduleForm
      tenantSlug={tenantSlug}
      appointmentId={appointment.id}
      currentStartsAt={appointment.startsAt}
      serviceName={services.find((service) => service.id === appointment.serviceId)?.name ?? null}
      availability={availability}
      timeZone={tenant.timezone}
      // « Voir plus de jours » n'a plus rien à élargir une fois la fenêtre au
      // maximum du contrat : le bouton disparaît (`states.md`, étape 3).
      widerHref={wide ? null : `${here}?${WIDE_WINDOW_PARAM}=${WIDE_WINDOW_VALUE}`}
    />
  );
}
