'use client';

import {
  ERROR_CODES,
  type BookedAppointment,
  type PublicService,
  type PublicTenant,
  type UtcInstant,
} from '@spa/shared';
import { useState } from 'react';

import { BookingActionBar } from '@/components/booking/summary-bar';
import { Button } from '@/components/ui/button';
import { Notification, type NotificationTone } from '@/components/ui/notification';
import type { ContactDraft } from '@/lib/booking/draft';

import { bookAppointmentAction } from '../actions';

import { BookingAppointmentCard, endOfBooking } from './appointment-card';
import { ContactRecap } from './recap';

interface SummaryStepProps {
  readonly tenant: PublicTenant;
  readonly service: PublicService;
  readonly staffId: string | null;
  readonly startsAt: UtcInstant;
  readonly contact: ContactDraft;
  /** Rouvre l'étape « Coordonnées » — la correction du bloc, et celle du refus d'adresse. */
  readonly onBack: () => void;
  /** Rouvre l'étape « Créneau » (`BM-TUNNEL-01`). */
  readonly onEditSlot: () => void;
  /** Rouvre l'étape « Prestation », où se choisissent le soin et le praticien. */
  readonly onEditService: () => void;
  readonly onBooked: (appointment: BookedAppointment) => void;
  /**
   * Sans argument, délibérément : le créneau perdu et son libellé sont connus de
   * l'orchestrateur, et le message de l'API n'a pas à traverser cette frontière
   * (#46 — voir `onSlotLost` dans `booking-tunnel.tsx`).
   */
  readonly onSlotLost: () => void;
  /**
   * L'action a refusé faute de compte (2026-09-22) — le cookie de présence a
   * disparu depuis le rendu de la page. Sans argument, pour la même raison que
   * `onSlotLost` : c'est le tunnel qui ramène à l'écran de connexion et qui
   * écrit ce qu'il faut en dire.
   */
  readonly onSignInRequired: () => void;
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
 * ## Ce que #1051 y change
 *
 * L'écran s'ouvre sur une **carte** — bloc date, plage horaire, prestation,
 * praticien, salon, total aligné à droite — et non plus sur neuf couples
 * libellé / valeur (`BM-TUNNEL-01`, `BM-VISUEL-03`). Chaque bloc porte son
 * « Modifier », qui rouvre **son** étape sans faire perdre les autres choix :
 * c'est ce que le motif demande, et ce que le brouillon permet déjà
 * (`lib/booking/draft.ts`). Ne restent en liste que les coordonnées, qui sont
 * réellement des couples libellé / valeur (`ContactRecap`).
 *
 * Un seul bouton plein sur l'écran, « Confirmer la réservation » dans la barre
 * basse (`BM-VISUEL-02`) : les corrections sont des boutons discrets, et la
 * seule autre action nommée — « Corriger mes coordonnées » — n'apparaît qu'avec
 * le refus qui la désigne.
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
  onEditSlot,
  onEditService,
  onBooked,
  onSlotLost,
  onSignInRequired,
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
      // L'accord coché à l'étape « Coordonnées », transporté jusqu'à l'API
      // (#790). Il vient du brouillon et non d'une constante : c'est ce qui
      // relie la case que la cliente a cochée à la ligne que le salon
      // conservera. Envoyé tel quel, y compris `false` — la validation de
      // l'action serveur le refusera alors, et c'est ce qu'on veut : un
      // récapitulatif atteint sans consentement est un état que le tunnel ne
      // doit pas savoir réparer tout seul, et `draft.ts` interdit déjà d'y
      // arriver.
      dataConsent: contact.consent,
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

    // Réserver exige un compte, et l'action l'a constaté absent : la correction
    // est la connexion, que seul le tunnel sait rouvrir.
    if (result.code === ERROR_CODES.UNAUTHORIZED) {
      onSignInRequired();

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
    <section className="spa-booking__step" aria-label="Récapitulatif de votre réservation">
      {/* Plus de titre d'étape ici : le `<h1>` du tunnel pose la question —
          « Tout est-il exact ? » —, et « Vérifiez votre réservation » juste
          au-dessous la redisait en d'autres mots (#1047, BM-TUNNEL-11). */}
      {refusal === null ? null : (
        <Notification tone={refusal.tone} title={refusal.title}>
          <p>{refusal.body}</p>
          {/* La correction nommée, **dans** le refus qui la désigne (#452,
              #1051). Elle vivait en rangée permanente au bas de l'étape, où
              elle doublait le « Modifier » du bloc de coordonnées ; ici, elle
              n'apparaît qu'au moment où la phrase ci-dessus dit d'y aller, et
              elle dit ce qu'on va changer, là où « ← Retour » de l'en-tête ne
              dit que « revenir ». */}
          <div className="spa-booking__actions">
            <Button variant="quiet" onClick={onBack} disabled={submitting}>
              Corriger mes coordonnées
            </Button>
          </div>
        </Notification>
      )}

      <BookingAppointmentCard
        tenant={tenant}
        serviceName={service.name}
        durationMinutes={service.durationMinutes}
        staffName={staffName}
        startsAt={startsAt}
        endsAt={endOfBooking(startsAt, service.durationMinutes)}
        price={service.price}
        onEditSlot={onEditSlot}
        onEditService={onEditService}
      />

      <ContactRecap contact={contact} onEdit={onBack} />

      {/*
        Ce qu'il faut savoir avant de s'engager, et qui n'était écrit nulle part
        (#735).

        ## Pourquoi ici, et pas ailleurs

        C'est le dernier écran où l'on peut encore renoncer. Le critère
        `ds:confiance` de l'audit de conception porte sur « ce qui permet de
        décider — prix, durée, annulation, identité du salon » : les trois
        premiers sont dans le récapitulatif au-dessus, les deux derniers
        n'existaient sur aucun écran du tunnel, jusqu'au bouton de confirmation
        inclus.

        ## Pourquoi ces deux phrases-là

        Elles décrivent ce que le produit fait, et rien de plus :

        - **le règlement.** Le tunnel n'a pas d'étape de paiement et n'en
          demande aucun : l'encaissement du MVP est celui du comptoir
          (CDC §1.4, « Encaissement au checkout (carte/espèces) »), servi par
          l'écran d'encaissement du back-office. Une cliente qui s'attend à
          payer en ligne et ne trouve pas où le faire abandonne ; il faut donc
          le lui dire avant qu'elle le cherche. Le moyen de paiement accepté
          n'est en revanche **pas** énoncé : c'est le salon qui en décide, et
          l'API n'expose rien qui le dise ;
        - **l'annulation.** `AppointmentsService.cancel` n'oppose ni frais ni
          préavis : seul le cycle de vie refuse le passage, une fois le
          rendez-vous honoré, déjà annulé ou marqué no-show. La phrase dit donc
          « tant que le rendez-vous n'a pas eu lieu », et rien de plus.

        Pourquoi un encart et non de la prose au fil de la carte : la même
        raison que `.spa-consent` à l'étape précédente — ce n'est pas une ligne
        du récapitulatif, c'est ce qu'il faut avoir lu avant de soumettre, et la
        hiérarchie le dit avant la lecture (skill `web-frontend` §6). Ce n'est
        pas `.spa-consent` pour autant : il n'y a rien à accepter ici, aucun
        contrôle, et rien qui garde le bouton.

        ## Deux puces d'une ligne, et c'est une contrainte (#1051)

        L'audit `d20260918-1` mesure cet encart à **neuf lignes** à 360 px, au
        milieu d'un écran où la cliente cherche le bouton. Ce qui a été coupé est
        ce qui se lit ailleurs, et mieux :

        - *« Aucun paiement n'est demandé en ligne »* redisait « sur place » en
          creux ; le tunnel n'a aucune étape de paiement, l'absence se constate
          sans être annoncée deux fois ;
        - la liste des surfaces qui annulent — écran suivant, espace client,
          comptoir — est une aide au **geste**, pas à la décision. Elle est à sa
          place sur l'écran de confirmation, où l'annulation se fait, et non sur
          celui où l'on décide de réserver.

        Il reste donc les deux faits qui engagent : où l'on paie, et à quelles
        conditions on peut renoncer.
      */}
      <div className="spa-booking__terms">
        {/* `<h2>` et non `<h3>` : le titre d'étape « Vérifiez votre réservation »
            a disparu avec #1047 — le `<h1>` du tunnel pose désormais la question
            —, et un `h3` sauterait le niveau 2 de la page (WCAG 1.3.1). Le corps
            reste celui de `.spa-booking__terms-title` : c'est la classe qui le
            décide, pas l'élément. */}
        <h2 className="spa-booking__terms-title">Avant de confirmer</h2>
        <ul className="spa-list spa-booking__terms-list">
          <li>
            {/* Le montant n'est pas redit : il est deux lignes plus haut, dans
                la carte. Ce que cette phrase ajoute, c'est *où* et *quand* il se
                règle, pas *combien*. */}
            <span className="spa-booking__terms-label">Règlement sur place</span>, le jour du
            rendez-vous.
          </li>
          <li>
            <span className="spa-booking__terms-label">Annulation sans frais</span> tant que le
            rendez-vous n’a pas eu lieu.
          </li>
        </ul>
      </div>

      {/* L'action primaire dans la barre basse (#1047), sans rappel : ces faits
          **sont** l'écran, et les redire deux cents pixels plus bas ferait lire
          deux récapitulatifs pour une réservation. */}
      <BookingActionBar>
        <Button
          variant="accent"
          block
          loading={submitting}
          loadingLabel="Réservation en cours…"
          onClick={() => {
            void confirm();
          }}
        >
          Confirmer la réservation
        </Button>
      </BookingActionBar>
    </section>
  );
}
