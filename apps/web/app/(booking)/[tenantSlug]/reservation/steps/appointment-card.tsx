import type { Money, PublicTenant, UtcInstant } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';

import { addressLines } from '@/components/salon/salon-address';
import { Avatar } from '@/components/ui/avatar';
import { DateBlock } from '@/components/ui/date-block';
import { Icon } from '@/components/ui/icon';
import {
  formatDuration,
  formatMoney,
  formatTimeInTimeZone,
  type DisplayLocale,
} from '@/lib/format';

/**
 * L'instant de fin, déduit d'une durée — « 09:00 – 10:00 » plutôt que « 09:00 ».
 *
 * Utile au **récapitulatif** seulement : le rendez-vous n'existe pas encore, et
 * la seule borne connue est le début choisi. Sur la confirmation, `endsAt` vient
 * du rendez-vous lui-même et cette fonction n'est pas appelée — c'est la borne
 * que l'API a réellement retenue qui fait foi, tampons de cabine exclus
 * (`billed-interval.ts`).
 *
 * L'arithmétique porte sur des **instants** et non sur des heures murales :
 * ajouter soixante minutes à un instant UTC reste juste la nuit d'un changement
 * d'heure, là où reconstruire « 02:30 + 1 h » dans le fuseau du salon ne l'est
 * pas (ADR 0006).
 *
 * Rend `null` sur tout ce qui n'est pas une durée positive : la carte affiche
 * alors l'heure de début seule, plutôt qu'une plage qui finirait avant de
 * commencer.
 */
export function endOfBooking(startsAt: UtcInstant, durationMinutes: number | null): UtcInstant | null {
  if (durationMinutes === null || durationMinutes <= 0) {
    return null;
  }

  const end = new Date(new Date(startsAt).getTime() + durationMinutes * 60_000);

  return Number.isNaN(end.getTime()) ? null : end.toISOString();
}

interface EditActionProps {
  /**
   * Ce que la correction rouvre — « la date et l'heure », « la prestation ».
   *
   * Déjà traduit par l'appelant : c'est lui qui sait **ce** que son bouton
   * rouvre, et les trois compléments vivent dans le catalogue, sous la section
   * de l'écran qui les emploie (#846).
   */
  readonly target: string;
  readonly onClick: () => void;
}

/**
 * Le « Modifier » d'un bloc (`BM-TUNNEL-01`).
 *
 * Le motif veut *« chaque élément avec "Modifier" »*, et que la correction se
 * fasse *« sans repartir de zéro »* : chaque bouton rouvre **son** étape, le
 * brouillon gardant tout le reste (`lib/booking/draft.ts`).
 *
 * Le mot visible est le même partout — c'est ce qui le rend reconnaissable d'un
 * bloc à l'autre — mais trois boutons nommés « Modifier » dans le même écran ne
 * se distinguent pas à l'oreille : le complément est donc écrit, et seulement
 * masqué visuellement (WCAG 2.4.6). Le nom accessible devient « Modifier la
 * date et l'heure ».
 */
export function EditAction({ target, onClick }: EditActionProps) {
  const t = useTranslations('booking');

  return (
    <button type="button" className="spa-booking__rdv-edit" onClick={onClick}>
      {t('tunnel.actions.edit')}
      <span className="spa-visually-hidden"> {target}</span>
    </button>
  );
}

interface BookingAppointmentCardProps {
  readonly tenant: PublicTenant;
  /** `null` si la prestation a quitté le catalogue depuis la réservation. */
  readonly serviceName: string | null;
  readonly durationMinutes: number | null;
  /** `null` = « premier disponible », pas « pas encore choisi ». */
  readonly staffName: string | null;
  readonly startsAt: UtcInstant;
  /** La borne de fin, quand elle est connue — voir `endOfBooking`. */
  readonly endsAt: UtcInstant | null;
  readonly price: Money | null;
  /** La correction du créneau, ou `null` sur un écran terminal. */
  readonly onEditSlot?: (() => void) | null;
  /** La correction de la prestation et du praticien, ou `null`. */
  readonly onEditService?: (() => void) | null;
}

/**
 * La carte du rendez-vous du tunnel (#1051) — récapitulatif et confirmation.
 *
 * ## Ce qu'elle remplace
 *
 * Une liste de neuf couples libellé / valeur, dont trois passaient à la ligne à
 * 360 px : l'audit `d20260918-1` la relève comme *« une liste désalignée »* où
 * *« le moment "c'est réservé" ne se voit pas »*. `BM-TUNNEL-01` veut au
 * contraire que l'étape finale s'ouvre sur *« l'établissement, la date, l'heure,
 * la durée, la prestation, le praticien et le prix »*, chacun corrigeable, et
 * `BM-VISUEL-03` que *« le prix soit en gras, la durée en retrait »*.
 *
 * ## Pourquoi la même carte aux deux écrans
 *
 * Même raison qu'avant elle : *ce que la cliente valide et ce qu'elle relit
 * ensuite doivent être la même chose*, sinon une différence de présentation se
 * lit comme une différence de rendez-vous. Seules les corrections changent —
 * elles n'existent pas une fois le créneau pris.
 *
 * ## Et pourquoi elle reprend la composition de l'espace client
 *
 * `AppointmentHero` (#1053) rend le même objet — bloc date en grand, plage
 * horaire et durée, prestation, praticien, salon, total — et l'issue demande
 * explicitement *« le même composant que la carte du prochain rendez-vous »*.
 * Ce sont les mêmes primitives du socle (`DateBlock`, `Avatar`, `Icon`) dans le
 * même ordre : une cliente qui passe de la confirmation à son espace retrouve la
 * carte qu'elle vient de voir.
 *
 * Elle n'est pas pour autant ce composant-là, et ce n'est pas un oubli : celui
 * de l'espace client est un Client Component qui porte l'annulation de la
 * session et le report, deux gestes que le tunnel ne connaît pas — il annule par
 * son action à lui, sans session. Le partager aurait demandé de lui passer ses
 * trois gestes en propriétés pour n'en utiliser aucun.
 *
 * Ni état, ni effet : elle est rendue dans l'arbre client du tunnel, mais
 * n'ajoute rien à son bundle au-delà de son balisage. Les corrections arrivent
 * en propriétés depuis le tunnel, qui est le seul à savoir ce qu'est une étape.
 *
 * L'heure est lue dans le fuseau de l'établissement (ADR 0006). La mention
 * explicite du fuseau, quand le visiteur est ailleurs, reste portée une seule
 * fois par la progression du tunnel.
 *
 * ## La langue (#846)
 *
 * L'heure, la durée et le montant passent par `lib/format.ts` avec la langue
 * résolue et le pays de l'établissement ; le **fuseau** ne bouge pas. Ce que la
 * carte affiche du salon — son nom, son adresse, le nom du praticien, celui de
 * la prestation — ne se traduit pas : c'est le contenu de l'établissement.
 */
export function BookingAppointmentCard({
  tenant,
  serviceName,
  durationMinutes,
  staffName,
  startsAt,
  endsAt,
  price,
  onEditSlot = null,
  onEditService = null,
}: BookingAppointmentCardProps) {
  const t = useTranslations('booking');
  const locale = useLocale();
  const display: DisplayLocale = { locale, countryCode: tenant.address?.country ?? null };
  /*
   * La plage horaire, composée ici plutôt que par `appointmentTimeRange` (#846).
   *
   * Cette fonction-là vit dans `components/account/`, qui n'est pas dans
   * l'empreinte de ce ticket : elle ne prend pas de contexte d'affichage, et sa
   * sortie reste donc en français — « 14:00 – 15:00 » à côté d'une durée et d'un
   * total en anglais, sur l'écran de confirmation d'une visiteuse anglophone.
   * Les deux heures viennent d'`Intl`, qui écrit « 2:00 PM » en `en-US`.
   *
   * Ce sont les **mêmes deux appels**, au même séparateur — espace insécable,
   * tiret demi-cadratin, espace insécable — pour que les deux écrans qui
   * montrent le même rendez-vous l'écrivent pareil. Le jour où l'espace client
   * est traduit à son tour, `appointmentTimeRange` prendra le contexte et ces
   * quatre lignes disparaîtront au profit d'un appel.
   *
   * Le **fuseau** ne bouge pas : c'est celui de l'établissement, langue ou non.
   */
  const start = formatTimeInTimeZone(startsAt, tenant.timezone, display);
  const hours =
    endsAt === null
      ? start
      : `${start}\u00a0–\u00a0${formatTimeInTimeZone(endsAt, tenant.timezone, display)}`;

  return (
    <article className="spa-booking__rdv">
      <div className="spa-booking__rdv-head">
        <DateBlock size="lg" instant={startsAt} timeZone={tenant.timezone} />

        <div className="spa-booking__rdv-when">
          <p className="spa-booking__rdv-hours">
            {hours}
            {/* La durée en retrait du même cran que chez `AppointmentHero` :
                `BM-VISUEL-03` veut *« la durée et les précisions en gris
                secondaire »*, et elle qualifie la plage horaire plutôt que de
                faire une ligne à elle. Omise plutôt que rendue à zéro : une
                durée nulle n'existe pas. */}
            {durationMinutes === null || durationMinutes <= 0 ? null : (
              <span className="spa-booking__rdv-duration">
                {' · '}
                {formatDuration(durationMinutes, display)}
              </span>
            )}
          </p>
          {/* `<p>` et non un titre : le `<h1>` de l'étape pose déjà la question
              de l'écran, et le seul `<h2>` du récapitulatif est « Avant de
              confirmer ». Un titre de plus ici ferait un plan de document où
              le rendez-vous et l'avertissement seraient de même rang. */}
          <p className="spa-booking__rdv-service">
            {serviceName ?? t('tunnel.appointmentCard.serviceFallback')}
          </p>
        </div>

        {onEditSlot === null ? null : (
          <div className="spa-booking__rdv-head-edit">
            <EditAction
              target={t('tunnel.appointmentCard.editSlotTarget')}
              onClick={onEditSlot}
            />
          </div>
        )}
      </div>

      <ul className="spa-booking__rdv-facts">
        <li className="spa-booking__rdv-fact">
          {/* Décoratif : le nom est écrit juste à côté. Sur « Premier
              disponible », aucune pastille — il n'y a personne à représenter,
              et « PD » se lirait comme des initiales. */}
          {staffName === null ? (
            <Icon name="users" className="spa-booking__rdv-fact-icon" />
          ) : (
            <Avatar name={staffName} size="sm" />
          )}
          <span className="spa-booking__rdv-fact-body">
            {/* La graisse porte sur le nom seul, et c'est la balise nommée du
                message qui le dit : « Avec <name>Nivo</name> » en français,
                « With <name>Nivo</name> » en anglais — la préposition n'est
                pas un morceau qu'on concatène (#846). */}
            {/* Le libellé de l'absence de préférence vient de son point
                d'écriture unique (CDC §1.4, `BM-PRATICIEN-01`) : c'est la clé
                que `StaffChoice` emploie, lue ici plutôt que redite — une copie
                de plus est exactement ce que `ds:libelles` relève. */}
            {t.rich('tunnel.appointmentCard.withStaff', {
              staff: staffName ?? t('tunnel.staffChoice.noPreference'),
              name: (chunks) => <strong>{chunks}</strong>,
            })}
          </span>
          {onEditService === null ? null : (
            <EditAction
              target={t('tunnel.appointmentCard.editServiceTarget')}
              onClick={onEditService}
            />
          )}
        </li>

        <li className="spa-booking__rdv-fact">
          <Icon name="pin" className="spa-booking__rdv-fact-icon" />
          {/* Un `div` et non un `span` : `address` est du contenu de flux, et un
              `span` n'accepte que du contenu de phrase — même enveloppe que la
              carte de l'espace client, qui pose la même adresse.

              Le salon est nommé même sans adresse publiée : `BM-TUNNEL-01`
              compte l'établissement parmi les sept faits du récapitulatif, et
              c'est le seul écran du tunnel où il n'est plus écrit ailleurs. Il
              ne porte pas de « Modifier » : on ne change pas de salon dans son
              tunnel, et offrir une correction qui n'existe pas serait pire que
              de n'en offrir aucune. */}
          <div className="spa-booking__rdv-fact-body">
            <address className="spa-booking__rdv-address">
              <span className="spa-booking__rdv-salon">{tenant.name}</span>
              {tenant.address === undefined
                ? null
                : addressLines(tenant.address).map((line, index) => (
                    <span key={index}>{line}</span>
                  ))}
            </address>
          </div>
        </li>
      </ul>

      {price === null ? null : (
        // Le total ferme la carte, aligné à droite et en graisse forte : c'est
        // ce que l'œil cherche en dernier avant de s'engager (`BM-VISUEL-03`).
        <p className="spa-booking__rdv-total">
          <span className="spa-booking__rdv-total-term">{t('tunnel.appointmentCard.total')}</span>
          <span className="spa-booking__rdv-total-value">{formatMoney(price, display)}</span>
        </p>
      )}
    </article>
  );
}
