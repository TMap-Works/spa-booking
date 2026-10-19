import type {
  AvailabilityQuery,
  AvailabilityResponse,
  BookedAppointment,
  CopilotSession,
  PublicService,
} from '@spa/shared';

import { daysInDayPart } from '@/lib/booking/slot-view';
import { formatDateTimeInTimeZone, formatTimeInTimeZone } from '@/lib/format';

import type { ServerTool } from '../claude-agent';
import { registryTool } from '../tools';

/**
 * Ce que plusieurs spécialistes partagent : lire les créneaux libres d'un
 * jour, et décrire un rendez-vous avec les noms du catalogue. Une seule
 * écriture pour une seule règle — la plage se découpe dans le fuseau du salon,
 * l'heure s'écrit à l'heure du salon.
 */

/** Créneaux cités au modèle au plus : il n'en dira que deux ou trois. */
const MAX_SLOTS = 12;

export type LoadAvailability = (tenantSlug: string, query: AvailabilityQuery) => Promise<AvailabilityResponse>;

export function slotsTool(
  id: 'disponibilite.creneaux' | 'planning.creneaux_libres',
  session: CopilotSession,
  services: ReadonlyMap<string, PublicService>,
  loadAvailability: LoadAvailability,
): ServerTool {
  return registryTool(id, async ({ prestation, praticien, jour, plage }) => {
    const service = services.get(prestation);
    if (service === undefined) {
      return { kind: 'resultat', contenu: 'Prestation inconnue : cherche-la dans le catalogue.', erreur: true };
    }
    const response = await loadAvailability(session.tenant.slug, {
      serviceId: prestation,
      ...(praticien === undefined ? {} : { staffId: praticien }),
      from: jour,
      to: jour,
    });
    const [day] = daysInDayPart(
      response.days.filter((entry) => entry.date === jour),
      plage ?? null,
      session.tenant.timezone,
    );
    const slots = day?.slots ?? [];
    if (slots.length === 0) {
      return { kind: 'resultat', contenu: `Aucun créneau libre le ${jour}${plage ? ` (${plage})` : ''}.` };
    }
    const names = new Map(service.staff.map((member) => [member.id, member.displayName]));
    const lines = slots.slice(0, MAX_SLOTS).map((slot) => {
      const time = formatTimeInTimeZone(slot.startsAt, session.tenant.timezone, { locale: session.locale });
      return `- ${time} avec ${names.get(slot.staffId) ?? 'un praticien'} (début ${slot.startsAt}, praticien [${slot.staffId}])`;
    });
    const more = slots.length > MAX_SLOTS ? `\n… et ${slots.length - MAX_SLOTS} autres.` : '';
    return { kind: 'resultat', contenu: `Créneaux libres le ${jour} :\n${lines.join('\n')}${more}` };
  });
}

/** Le nom d'une prestation et celui d'un praticien, tels que le catalogue les donne. */
export function namesOf(
  services: ReadonlyMap<string, PublicService>,
  serviceId: string,
  staffId: string,
): { readonly service: string; readonly staff: string | null } {
  const service = services.get(serviceId);
  return {
    service: service?.name ?? 'une prestation',
    staff: service?.staff.find((member) => member.id === staffId)?.displayName ?? null,
  };
}

/** Un rendez-vous, une ligne : ce que le modèle lit, identifiant compris. */
export function appointmentLine(
  appointment: BookedAppointment,
  services: ReadonlyMap<string, PublicService>,
  session: CopilotSession,
): string {
  const { service, staff } = namesOf(services, appointment.serviceId, appointment.staffId);
  const when = formatDateTimeInTimeZone(appointment.startsAt, session.tenant.timezone, { locale: session.locale });
  return `- [${appointment.id}] ${service}, ${when}${staff === null ? '' : ` avec ${staff}`} — statut ${appointment.status}, prestation [${appointment.serviceId}]`;
}
