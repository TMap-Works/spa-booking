'use client';

import type { PublicTenant, TimeZone } from '@spa/shared';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  appointmentIcsFilename,
  appointmentIcsHref,
  appointmentTimeRange,
  directionsUrl,
  pendingHoldNote,
  type AppointmentBrief,
} from '@/components/account/appointment-brief';
import { addressLines } from '@/components/salon/salon-address';
import { telUri } from '@/components/salon/salon-contact';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { DateBlock } from '@/components/ui/date-block';
import { Icon } from '@/components/ui/icon';
import { appointmentBadge, isStillActionable } from '@/lib/appointment-status';
import { formatDuration, formatMoney, timeZoneMention } from '@/lib/format';
import { formatPhoneForDisplay } from '@/lib/phone';

import { accountPath } from '../paths';
import { useAccountDisplay } from './account-display-locale';
import { CancelAppointmentControl } from './cancel-appointment-control';

/**
 * La carte du **prochain** rendez-vous — #1053.
 *
 * ## Ce qu'elle corrige
 *
 * L'audit `d20260918-1` relève que le prochain rendez-vous avait « l'habillage
 * exact des neuf cartes d'historique : ni praticien, ni adresse, ni heure de
 * fin ». Quatre motifs du benchmark tombaient avec :
 *
 * | Motif | Ce qu'il exige | Ce que la carte pose |
 * |---|---|---|
 * | `BM-RDV-01` | le prochain rendez-vous d'abord | elle ouvre l'écran, seule de son espèce |
 * | `BM-RDV-02` | quoi, avec qui, quand, où, combien, statut | prestation, praticien, plage horaire, adresse, prix, pastille |
 * | `BM-RDV-03` | l'ajout à l'agenda personnel | un `.ics` téléchargeable |
 * | `BM-RDV-04` | l'adresse et l'itinéraire à un geste | l'adresse écrite, le téléphone cliquable, « Itinéraire » |
 *
 * ## Pourquoi un Client Component
 *
 * Pour deux états, et rien d'autre : la mention de fuseau (qui dépend du fuseau
 * du **navigateur**) et le geste d'annulation (délégué à
 * `CancelAppointmentControl`). La page qui la monte reste un Server Component :
 * aucun jeton n'entre dans le bundle, cette carte ne reçoit qu'un rendez-vous et
 * l'établissement public. Le fichier d'agenda, lui, est une URL de données
 * calculée au rendu — voir `appointmentIcsHref` : le lien sort complet du
 * serveur et fonctionne même si le script ne charge jamais.
 */
interface AppointmentHeroProps {
  readonly tenantSlug: string;
  readonly brief: AppointmentBrief;
  readonly tenant: PublicTenant;
  readonly timeZone: TimeZone;
}

export function AppointmentHero({ tenantSlug, brief, tenant, timeZone }: AppointmentHeroProps) {
  const t = useTranslations('account.appointments');
  const display = useAccountDisplay();
  const router = useRouter();
  const { appointment, serviceName, practitioner, durationMinutes } = brief;

  /**
   * La mention du fuseau, calculée **après le montage** seulement (#680).
   *
   * `timeZoneMention` lit le fuseau du navigateur, qui n'existe pas au rendu
   * serveur : au premier rendu la mention est absente des deux côtés, donc les
   * balises s'accordent ; l'effet ne joue qu'ensuite, sur le client seul.
   */
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const badge = appointmentBadge(appointment, 'upcoming', display.locale);
  const actionable = isStillActionable(appointment);
  const mention = mounted ? timeZoneMention(timeZone, display) : null;
  const directions = directionsUrl(tenant);
  const phone = tenant.contactPhone;

  return (
    <article className="spa-rdv-hero">
      <div className="spa-rdv-hero__head">
        <DateBlock size="lg" instant={appointment.startsAt} timeZone={timeZone} display={display} />

        <div className="spa-rdv-hero__when">
          <p className="spa-rdv-hero__time">
            {appointmentTimeRange(appointment, timeZone, display)}
            <span className="spa-rdv-hero__duration">
              {' · '}
              {formatDuration(durationMinutes, display)}
            </span>
            {mention === null ? null : (
              <span className="spa-rdv-hero__timezone"> ({mention})</span>
            )}
          </p>
          <h3 className="spa-rdv-hero__service">{serviceName ?? t('serviceFallback')}</h3>
          <p className="spa-rdv-hero__price">{formatMoney(appointment.price, display)}</p>
        </div>

        <div className="spa-rdv-hero__status">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {appointment.status === 'pending' ? (
            // La ligne que les quatre lignes d'explication de la section disaient
            // avant #1053 : le créneau est déjà retenu — `pending` fait partie des
            // `BLOCKING_APPOINTMENT_STATUSES` —, l'attente ne demande rien à la
            // cliente. Aucun délai n'est chiffré : l'API n'en expose aucun.
            //
            // La condition porte sur le **statut** et non plus sur le libellé de
            // la pastille (#847) : une comparaison de chaînes contre un libellé
            // français devenait fausse dès que l'écran s'affichait en anglais, et
            // la ligne disparaissait sans rien dire. Cette carte n'affiche que la
            // moitié « à venir », si bien que `pending` y veut toujours dire « le
            // salon n'a pas encore confirmé ».
            <p className="spa-rdv-hero__status-note">{pendingHoldNote(display.locale)}</p>
          ) : null}
        </div>
      </div>

      <ul className="spa-rdv-hero__facts">
        {practitioner === null ? null : (
          <li className="spa-rdv-hero__fact">
            <Avatar name={practitioner} size="sm" />
            {/* Le nom est un **paramètre du message** et non une concaténation :
                l'ordre des mots ne survit pas à une traduction, et « With Hery »
                ne place pas le nom là où le français le met. */}
            <span>{t.rich('with', { practitioner, name: (parts) => <strong>{parts}</strong> })}</span>
          </li>
        )}

        {tenant.address === undefined ? null : (
          <li className="spa-rdv-hero__fact">
            <Icon name="pin" className="spa-rdv-hero__fact-icon" />
            {/* Un `div` et non un `span` : `address` est du contenu de flux, et
                un `span` n'accepte que du contenu de phrase — même enveloppe que
                `SalonAside`, qui pose la même adresse. */}
            <div>
              <address className="spa-rdv-hero__address">
                <span className="spa-rdv-hero__salon">{tenant.name}</span>
                {addressLines(tenant.address).map((line, index) => (
                  <span key={index}>{line}</span>
                ))}
              </address>
              {directions === null ? null : (
                <a
                  className="spa-rdv-hero__link"
                  href={directions}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('directions')}
                  <Icon name="external" />
                </a>
              )}
            </div>
          </li>
        )}

        {phone === undefined ? null : (
          <li className="spa-rdv-hero__fact">
            <Icon name="phone" className="spa-rdv-hero__fact-icon" />
            <a className="spa-rdv-hero__link" href={telUri(phone)}>
              {formatPhoneForDisplay(phone)}
            </a>
          </li>
        )}
      </ul>

      {appointment.clientNote === null || appointment.clientNote === '' ? null : (
        <p className="spa-appointment__note">« {appointment.clientNote} »</p>
      )}

      <div className="spa-rdv-hero__actions">
        <a
          className="spa-button spa-button--neutral"
          href={appointmentIcsHref({ brief, tenant, locale: display.locale })}
          download={appointmentIcsFilename(appointment, display.locale)}
        >
          <span className="spa-button__label">{t('addToCalendar')}</span>
        </a>

        {!actionable ? null : (
          <>
            <Link
              className="spa-button spa-button--neutral"
              href={accountPath(tenantSlug, `/rendez-vous/${appointment.id}/report`)}
            >
              <span className="spa-button__label">{t('reschedule')}</span>
            </Link>
            <CancelAppointmentControl
              tenantSlug={tenantSlug}
              appointment={appointment}
              timeZone={timeZone}
              tone="link"
              // La liste est rendue côté serveur : c'est elle qu'il faut refaire,
              // pas un état local à recoller. Le rendez-vous annulé bascule alors
              // de lui-même vers l'historique.
              onCancelled={() => {
                router.refresh();
              }}
            />
          </>
        )}
      </div>
    </article>
  );
}
