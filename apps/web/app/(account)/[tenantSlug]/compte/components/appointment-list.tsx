import type {
  AppointmentScope,
  BookedAppointment,
  PublicService,
  TimeZone,
} from '@spa/shared';
import Link from 'next/link';

import type { ButtonVariant } from '@/components/ui/button';

import { AppointmentCard } from './appointment-card';

/** La sortie proposée par un état vide : une destination, jamais une commande. */
interface AppointmentListAction {
  readonly href: string;
  readonly label: string;
  /** `accent` pour la sortie principale de l'écran, `neutral` pour la seconde. */
  readonly variant: ButtonVariant;
}

/**
 * Une moitié de l'espace client — « Rendez-vous à venir » ou « Historique ».
 *
 * Server Component : rien ici n'a d'état, et ce qui en a — les deux gestes d'une
 * ligne — vit dans `AppointmentCard`. C'est ce découpage qui garde la session
 * hors du bundle : la liste lit l'API avec le jeton, les cartes ne reçoivent que
 * des rendez-vous.
 *
 * ## L'état vide dit **pourquoi** il est vide — et par où en sortir
 *
 * Un écran vide sans explication est un bug d'UX (web-frontend §6), et les deux
 * moitiés n'ont pas le même vide : « aucun rendez-vous à venir » invite à
 * réserver, « votre historique est vide » constate. Le libellé est donc passé
 * par l'appelant plutôt que déduit ici.
 *
 * L'explication ne suffit pourtant pas : `docs/design/appointments/states.md`
 * § « Règles générales » exige qu'un vide porte « une explication **et au moins
 * une action** pour sortir de l'impasse — un cul-de-sac muet fait abandonner ».
 * Les deux moitiés d'un compte neuf étaient exactement cela : deux blocs qui
 * demandent de réserver sans rien offrir à cliquer (#745). L'action est donc un
 * **paramètre obligatoire** et non optionnel — une future moitié ne peut pas
 * réintroduire le cul-de-sac par omission.
 */
interface AppointmentListProps {
  readonly tenantSlug: string;
  readonly appointments: readonly BookedAppointment[];
  readonly timeZone: TimeZone;
  /** Le catalogue public, pour nommer la prestation de chaque ligne. */
  readonly services: readonly PublicService[];
  /**
   * La moitié servie — c'est elle qui décide si une ligne porte encore ses deux
   * gestes. Voir l'en-tête d'`AppointmentCard` : le statut seul ne suffit pas.
   */
  readonly scope: AppointmentScope;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly emptyAction: AppointmentListAction;
}

export function AppointmentList({
  tenantSlug,
  appointments,
  timeZone,
  services,
  scope,
  emptyTitle,
  emptyDescription,
  emptyAction,
}: AppointmentListProps) {
  if (appointments.length === 0) {
    return (
      <div className="spa-empty-state">
        <p className="spa-empty-state__title">{emptyTitle}</p>
        <p className="spa-empty-state__description">{emptyDescription}</p>
        {/*
          Un lien et non un bouton : c'est une **destination**, elle s'ouvre dans
          un onglet et se copie. Posé directement dans `.spa-empty-state`, qui
          est déjà une colonne centrée avec son écart — même motif que l'état
          vide du planning (#788), et aucune classe nouvelle à styler, donc
          aucun style mort à faire vivre par une maquette.
        */}
        <Link className={`spa-button spa-button--${emptyAction.variant}`} href={emptyAction.href}>
          <span className="spa-button__label">{emptyAction.label}</span>
        </Link>
      </div>
    );
  }

  // Le catalogue **public** ne contient que les prestations encore en vente : un
  // soin retiré depuis laisse une ligne sans nom, et la carte affiche alors un
  // libellé générique plutôt que de disparaître de l'historique.
  const namesById = new Map(services.map((service) => [service.id, service.name]));

  return (
    <ul className="spa-appointment-list">
      {appointments.map((appointment) => (
        <AppointmentCard
          key={appointment.id}
          tenantSlug={tenantSlug}
          appointment={appointment}
          timeZone={timeZone}
          serviceName={namesById.get(appointment.serviceId) ?? null}
          scope={scope}
        />
      ))}
    </ul>
  );
}
