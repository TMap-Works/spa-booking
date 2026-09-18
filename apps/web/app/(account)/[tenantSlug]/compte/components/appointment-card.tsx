'use client';

import type { AppointmentScope, TimeZone } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  appointmentTimeRange,
  PENDING_HOLD_NOTE,
  RESCHEDULED_NOTE,
  type AppointmentBrief,
} from '@/components/account/appointment-brief';
import { Badge } from '@/components/ui/badge';
import { DateBlock } from '@/components/ui/date-block';
import {
  appointmentBadge,
  isStillActionable,
  PENDING_CONFIRMATION_LABEL,
  RESCHEDULED_LABEL,
} from '@/lib/appointment-status';
import { formatDuration, formatMoney, timeZoneMention } from '@/lib/format';

import { accountPath } from '../paths';
import { CancelAppointmentControl } from './cancel-appointment-control';

/**
 * Une carte **compacte** de rendez-vous : les rendez-vous à venir qui suivent le
 * prochain, et toutes les lignes de l'historique.
 *
 * Le prochain rendez-vous, lui, a sa propre carte (`appointment-hero.tsx`) :
 * c'est tout l'objet de #1053, où l'audit relève que « le prochain rendez-vous a
 * l'habillage d'une ligne d'historique ».
 *
 * ## Ce que la carte dit depuis #1053
 *
 * `BM-RDV-02` veut « quoi, avec qui, quand, où, combien, et son statut » sur
 * chaque carte, et reproche nommément à Planity de taire le praticien réservé.
 * La ligne de métadonnées le nomme donc, à côté de la plage horaire et de la
 * durée ; le bloc date rend la carte balayable sans lire.
 *
 * ## La ligne sous la pastille remplace les paragraphes de section (#1053)
 *
 * Les deux moitiés de l'espace portaient chacune quatre lignes d'explication
 * sous leur titre, que l'audit relève comme un mur de texte avant le contenu.
 * Ce qu'elles disaient d'utile tient en une ligne, **attachée au rendez-vous
 * qu'elle concerne** :
 *
 * | Cas | La ligne |
 * |---|---|
 * | `pending` à venir | « Votre créneau est retenu ; rien à faire de votre côté. » |
 * | déplacé (annulé sans auteur) | « Ce créneau a été libéré au profit d'un autre rendez-vous. » |
 * | tout le reste | rien — la pastille se suffit |
 *
 * Deux cas seulement, et non un commentaire sur chaque carte : « Honoré » et
 * « Annulé par vous » ne laissent aucune question ouverte. « Déplacé », si —
 * c'est le seul mot de la table de statuts qui ne corresponde à aucun statut
 * (`lib/appointment-status.ts`), et il ne dit pas de lui-même où est passé le
 * rendez-vous. Ce que #744 avait mis en légende de section — une date future
 * sous « Historique » n'est pas une erreur de tri — reste porté par l'intitulé
 * « Historique », qui ne promet aucun critère de créneau.
 *
 * ## Les gestes dépendent de la moitié, pas seulement du statut
 *
 * `isStillActionable` ne regarde que le statut, et cela ne suffit pas : un
 * rendez-vous d'hier que le salon n'a pas encore marqué « honoré » reste
 * `confirmed`, et le serveur le range — à raison — dans l'historique. Y offrir
 * les deux gestes serait faux des deux côtés : « Reporter » mène à un écran qui
 * cherche le rendez-vous dans la moitié « à venir » et rend 404, et « Annuler »
 * **aboutit** — `confirmed → cancelled` est une transition licite —, faisant
 * passer pour annulée une visite qui a bien eu lieu, et faussant le comptage des
 * visites honorées du CDC §1.4.
 */
interface AppointmentCardProps {
  readonly tenantSlug: string;
  readonly brief: AppointmentBrief;
  readonly timeZone: TimeZone;
  /** La moitié d'historique d'où vient cette carte — voir l'en-tête. */
  readonly scope: AppointmentScope;
}

export function AppointmentCard({ tenantSlug, brief, timeZone, scope }: AppointmentCardProps) {
  const router = useRouter();
  const { appointment, serviceName, practitioner, durationMinutes } = brief;

  /**
   * La mention du fuseau, calculée **après le montage** seulement (#680) :
   * `timeZoneMention` lit le fuseau du navigateur, qui n'existe pas au rendu
   * serveur. Au premier rendu elle est absente des deux côtés, donc les balises
   * s'accordent ; l'effet ne joue qu'ensuite, sur le client seul.
   */
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const badge = appointmentBadge(appointment, scope);
  const actionable = scope === 'upcoming' && isStillActionable(appointment);
  const mention = mounted ? timeZoneMention(timeZone) : null;
  const note = statusNote(badge.label, scope);

  return (
    <li className="spa-appointment">
      <div className="spa-appointment__summary">
        <DateBlock instant={appointment.startsAt} timeZone={timeZone} />

        <div className="spa-appointment__body">
          <p className="spa-appointment__service">{serviceName ?? 'Prestation'}</p>
          <p className="spa-appointment__meta">
            {appointmentTimeRange(appointment, timeZone)}
            <span className="spa-appointment__dot"> · </span>
            {formatDuration(durationMinutes)}
            {practitioner === null ? null : (
              <>
                <span className="spa-appointment__dot"> · </span>
                {practitioner}
              </>
            )}
            {mention === null ? null : (
              <span className="spa-appointment__timezone"> ({mention})</span>
            )}
          </p>
        </div>

        <div className="spa-appointment__status">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <p className="spa-appointment__price">{formatMoney(appointment.price)}</p>
        </div>
      </div>

      {note === null ? null : <p className="spa-appointment__status-note">{note}</p>}

      {appointment.clientNote === null || appointment.clientNote === '' ? null : (
        <p className="spa-appointment__note">« {appointment.clientNote} »</p>
      )}

      {!actionable ? null : (
        <div className="spa-appointment__actions">
          <Link
            className="spa-button spa-button--neutral"
            href={accountPath(tenantSlug, `/rendez-vous/${appointment.id}/report`)}
          >
            <span className="spa-button__label">Reporter</span>
          </Link>

          <CancelAppointmentControl
            tenantSlug={tenantSlug}
            appointment={appointment}
            timeZone={timeZone}
            // La liste est rendue côté serveur : c'est elle qu'il faut refaire,
            // pas un état local à recoller.
            onCancelled={() => {
              router.refresh();
            }}
          />
        </div>
      )}
    </li>
  );
}

/**
 * La ligne qui suit la pastille, quand celle-ci laisse une question ouverte.
 *
 * Elle est déduite du **libellé** déjà calculé et non du statut brut : c'est
 * `appointmentBadge` qui tranche ce que la carte annonce, et déduire deux fois
 * la même chose de deux façons est exactement comment les libellés de statut
 * avaient divergé sur trois écrans (#917).
 */
function statusNote(label: string, scope: AppointmentScope): string | null {
  if (label === PENDING_CONFIRMATION_LABEL) {
    return PENDING_HOLD_NOTE;
  }

  if (scope === 'upcoming') {
    return null;
  }

  if (label === RESCHEDULED_LABEL) {
    return RESCHEDULED_NOTE;
  }

  return null;
}
