'use client';

import {
  ERROR_CODES,
  type BookedAppointment,
  type PublicService,
  type PublicTenant,
  type UtcInstant,
} from '@spa/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification, type NotificationTone } from '@/components/ui/notification';
import type { ContactDraft } from '@/lib/booking/draft';

import { bookAppointmentAction } from '../actions';

import { Recap } from './recap';

interface SummaryStepProps {
  readonly tenant: PublicTenant;
  readonly service: PublicService;
  readonly staffId: string | null;
  readonly startsAt: UtcInstant;
  readonly contact: ContactDraft;
  readonly onBack: () => void;
  readonly onBooked: (appointment: BookedAppointment) => void;
  /**
   * Sans argument, délibérément : le créneau perdu et son libellé sont connus de
   * l'orchestrateur, et le message de l'API n'a pas à traverser cette frontière
   * (#46 — voir `onSlotLost` dans `booking-tunnel.tsx`).
   */
  readonly onSlotLost: () => void;
}

/** Ce qui s'affiche au-dessus du récapitulatif quand la réservation est refusée. */
interface Refusal {
  readonly tone: NotificationTone;
  readonly title: string;
  readonly body: string;
}

/**
 * Le refus qu'aucun autre créneau ne lèvera — `CLIENT_EMAIL_NOT_BOOKABLE` (#452).
 *
 * ## Pourquoi il ne renvoie pas au calendrier
 *
 * C'est un 409 comme `SLOT_NO_LONGER_AVAILABLE`, et c'est tout ce que les deux
 * ont en commun. Le créneau perdu est **passager** : un autre horaire le résout,
 * d'où le retour à l'étape `creneau`. Celui-ci est **définitif pour cette
 * adresse** — la faire choisir un autre horaire lui ferait reparcourir le tunnel
 * pour se heurter au même mur. La seule action utile est à un écran d'ici :
 * « Corriger mes coordonnées », que ce composant affiche déjà.
 *
 * ## Pourquoi la phrase est écrite ici et ne dit pas la cause
 *
 * Écrite ici, parce que seul le `code` engage l'API : le `message` du contrat
 * s'adresse à un développeur, il est traduisible et peut changer sans préavis
 * (skill web-frontend §2) — même arbitrage que pour `onSlotLost` dans
 * `booking-tunnel.tsx`.
 *
 * Sans la cause, parce que la route est **publique et non authentifiée**. Côté
 * serveur, l'adresse est refusée parce qu'elle porte un compte non client de
 * l'établissement ; l'écrire à l'écran ferait de ce formulaire un oracle sur
 * l'annuaire du personnel, que n'importe qui pourrait interroger adresse par
 * adresse. La phrase constate donc le refus et propose la suite, sans qualifier
 * l'adresse ni confirmer qu'elle appartient à quelqu'un.
 */
const EMAIL_NOT_BOOKABLE: Refusal = {
  // `warning` et non `danger` : rien n'est cassé, et l'action à mener est claire.
  // Le ton porte aussi `role="alert"`, donc l'annonce reste immédiate au lecteur
  // d'écran — le visiteur vient de cliquer, il attend une réponse.
  tone: 'warning',
  title: 'Cette adresse e-mail ne peut pas être utilisée ici',
  body:
    'La réservation en ligne n’accepte pas cette adresse pour cet établissement. ' +
    'Reprenez vos coordonnées pour en saisir une autre : votre prestation et ' +
    'votre créneau sont conservés. Si vous tenez à cette adresse, contactez ' +
    'directement l’établissement.',
};

/**
 * Récapitulatif et validation — quatrième critère d'acceptation de #45.
 *
 * ## Le bouton se désactive dès le premier clic
 *
 * Deux verrous, et les deux sont nécessaires :
 *
 * - `Button` pose `disabled` dès que `loading` l'est, ce qui écarte le second
 *   clic ;
 * - la garde `if (submitting) return` en tête du gestionnaire écarte l'appel
 *   qu'un clavier ou un script pourrait déclencher entre le clic et le rendu qui
 *   désactive le bouton. Sans elle, le `disabled` n'est qu'une protection
 *   d'affichage — React ne réagit pas avant la fin du gestionnaire en cours.
 *
 * Un double clic ne doit jamais produire deux réservations (skill web-frontend
 * §3).
 */
export function SummaryStep({
  tenant,
  service,
  staffId,
  startsAt,
  contact,
  onBack,
  onBooked,
  onSlotLost,
}: SummaryStepProps) {
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const staffName = service.staff.find((member) => member.id === staffId)?.displayName ?? null;

  const confirm = async () => {
    if (submitting) {
      return;
    }

    setSubmitting(true);
    setRefusal(null);

    const result = await bookAppointmentAction(tenant.slug, {
      serviceId: service.id,
      ...(staffId === null ? {} : { staffId }),
      startsAt,
      client: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        ...(contact.phone === '' ? {} : { phone: contact.phone }),
      },
      ...(contact.clientNote === '' ? {} : { clientNote: contact.clientNote }),
    });

    if (result.ok) {
      onBooked(result.data);

      return;
    }

    // Le créneau parti pendant la saisie n'est pas une panne : c'est le cas
    // normal sous concurrence, et il se traite par un retour au calendrier.
    //
    // Le tri se fait sur le **code** et sur lui seul (#46) : c'est le seul champ
    // du corps d'erreur que l'API s'engage à tenir. Trier sur le message ferait
    // dépendre le parcours critique d'une chaîne de caractères qu'une
    // reformulation côté serveur suffirait à casser — et le 409 retomberait
    // alors dans la panne générique ci-dessous, qui laisse la cliente devant un
    // créneau qu'elle ne pourra jamais obtenir.
    if (result.code === ERROR_CODES.SLOT_NO_LONGER_AVAILABLE) {
      onSlotLost();

      return;
    }

    // L'autre 409 du parcours, et le seul que le calendrier ne résout pas —
    // voir `EMAIL_NOT_BOOKABLE`. Il reste **sur cette étape** : la correction
    // est à un écran d'ici, pas cinq.
    setRefusal(
      result.code === ERROR_CODES.CLIENT_EMAIL_NOT_BOOKABLE
        ? EMAIL_NOT_BOOKABLE
        : { tone: 'danger', title: 'La réservation n’a pas abouti', body: result.message },
    );
    // Le bouton se réarme, dans les deux cas : la panne est peut-être passagère,
    // et sur le refus d'adresse c'est ce qui rend « Corriger mes coordonnées »
    // — désactivé tant que la soumission court — de nouveau cliquable. Sans
    // cela, la seule issue offerte serait le rechargement de la page.
    setSubmitting(false);
  };

  return (
    <section aria-label="Récapitulatif de votre réservation">
      <h2 className="spa-card__title">Vérifiez votre réservation</h2>

      {refusal === null ? null : (
        <Notification tone={refusal.tone} title={refusal.title}>
          <p>{refusal.body}</p>
        </Notification>
      )}

      <Recap
        tenant={tenant}
        serviceName={service.name}
        staffName={staffName}
        startsAt={startsAt}
        price={service.price}
        contact={contact}
      />

      <div className="spa-card__footer">
        <Button variant="quiet" onClick={onBack} disabled={submitting}>
          Corriger mes coordonnées
        </Button>
        <Button
          variant="accent"
          loading={submitting}
          loadingLabel="Réservation en cours…"
          onClick={() => {
            void confirm();
          }}
        >
          Confirmer la réservation
        </Button>
      </div>
    </section>
  );
}
