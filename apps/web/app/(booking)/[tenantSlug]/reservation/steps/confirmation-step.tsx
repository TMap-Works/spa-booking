'use client';

import type { BookedAppointment, PublicService, PublicTenant } from '@spa/shared';
import Link from 'next/link';
import { useState } from 'react';

// Le chemin de l'espace client vient de son propre module — le seul endroit du
// front qui sache comment cette adresse s'écrit. Le réécrire ici en ferait une
// seconde source de vérité, et `paths.ts` est justement bâti pour être importé
// par des Client Components : il ne dépend de rien du serveur (voir son en-tête).
//
// Même raison pour le libellé de l'état : l'espace client et cet écran parlent
// du même rendez-vous, et c'est d'avoir écrit deux fois la même chose qu'ils ont
// fini par la dire autrement (#743). `lib/appointment-status.ts` ne dépend, lui
// aussi, que de types partagés — c'est ce qui lui permet d'être lu du tunnel, de
// l'espace client et du back-office à la fois (#917).
import { PENDING_CONFIRMATION_LABEL } from '@/lib/appointment-status';
import { accountPath } from '@/app/(account)/[tenantSlug]/compte/paths';
import {
  appointmentIcsFilename,
  appointmentIcsHref,
  PENDING_HOLD_NOTE,
  type AppointmentBrief,
} from '@/components/account/appointment-brief';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { Notification } from '@/components/ui/notification';
import type { ContactDraft } from '@/lib/booking/draft';

import { cancelAppointmentAction } from '../actions';

import { BookingAppointmentCard } from './appointment-card';

interface ConfirmationStepProps {
  readonly tenant: PublicTenant;
  /** `null` si la prestation a quitté le catalogue depuis la réservation. */
  readonly service: PublicService | null;
  readonly appointment: BookedAppointment;
  readonly contact: ContactDraft;
  /**
   * Le rendez-vous vient du brouillon relu, et non de la réponse de l'API à la
   * réservation ou à l'annulation qu'on vient d'obtenir (#732).
   *
   * C'est la différence entre « voici ce que le salon a enregistré » et « voici
   * ce que cet onglet a retenu », et elle change ce que l'écran a le droit
   * d'affirmer — voir le commentaire de l'en-tête.
   */
  readonly restored: boolean;
  readonly onCancelled: (appointment: BookedAppointment) => void;
  readonly onRestart: () => void;
}

/**
 * La durée **réservée**, déduite du rendez-vous lui-même (#735).
 *
 * Et non de la prestation, parce que `service` peut être `null` ici : une
 * prestation retirée du catalogue public n'est plus dans la liste que le tunnel
 * reçoit, alors que le rendez-vous déjà pris, lui, garde son intervalle. Lire la
 * durée sur le rendez-vous, c'est la garder à l'écran dans ce cas-là.
 *
 * `startsAt` et `endsAt` bornent l'intervalle **facturé** — le soin, sans les
 * tampons de cabine, que l'API ne publie pas (`billed-interval.ts`). C'est bien
 * la durée annoncée à la cliente.
 *
 * Ce qu'il ne faut **pas** en conclure : que la durée serait figée à la
 * réservation comme l'est le prix. Elle ne l'est pas — `billedIntervalOf` calcule
 * `endsAt` avec le `durationMinutes` du catalogue **au moment de la lecture**, et
 * un salon qui rallonge son soin rallonge donc aussi les rendez-vous déjà pris.
 * Figer la durée demanderait de la porter sur la ligne `appointments`, comme le
 * prix : un changement de schéma, côté API, qui relève de son propre ticket.
 *
 * Rend `null` sur tout ce qui n'est pas une durée positive : un instant illisible
 * donnerait `NaN`, et l'afficher vaudrait moins que de ne rien afficher.
 */
function bookedMinutes(appointment: BookedAppointment): number | null {
  const minutes =
    (new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000;

  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null;
}

/** L'issue annoncée en tête d'écran — la pastille, le titre, et la phrase. */
interface Outcome {
  /** Le ton de la pastille : la couleur, et rien d'autre. */
  readonly tone: 'done' | 'pending' | 'cancelled';
  readonly icon: IconName;
  readonly title: string;
  readonly line: string;
}

/**
 * Ce que l'écran annonce, selon l'état **réel** du rendez-vous (#948, #1051).
 *
 * Trois issues, et jamais une quatrième formulation : le rendez-vous naît
 * `pending` côté API (`appointments.repository.ts`), et annoncer « c'est
 * réservé » sur une demande que le salon n'a pas encore confirmée ferait mentir
 * cet écran **et** contredire la pastille de l'espace client. Le mot de l'attente
 * est donc celui de `lib/appointment-status.ts`, et la phrase qui la qualifie
 * celle de `appointment-brief.ts` : deux écrans qui parlent du même rendez-vous
 * doivent en parler pareil (#743, #917).
 *
 * Rend `null` quand l'écran n'a le droit de rien affirmer — le brouillon relu
 * d'un rendez-vous encore actif. Voir « Ce que cet écran n'est pas ».
 */
function outcomeOf(appointment: BookedAppointment, restored: boolean): Outcome | null {
  if (appointment.status === 'cancelled') {
    // L'annulation est le seul état que le brouillon ne peut pas inventer : il
    // n'y arrive que par la réponse de l'API. Elle prime donc sur `restored`.
    return {
      tone: 'cancelled',
      icon: 'close',
      title: 'Votre rendez-vous est annulé',
      line: 'Il ne figure plus à l’agenda du salon. Vous pouvez en prendre un nouveau quand vous le souhaitez.',
    };
  }

  if (restored) {
    return null;
  }

  if (appointment.status === 'pending') {
    return {
      tone: 'pending',
      icon: 'clock',
      title: 'Demande envoyée',
      line: `${PENDING_CONFIRMATION_LABEL}. ${PENDING_HOLD_NOTE}`,
    };
  }

  return {
    tone: 'done',
    icon: 'check',
    title: 'C’est réservé !',
    line: 'Le salon a confirmé votre rendez-vous.',
  };
}

/**
 * Écran de confirmation — cinquième critère d'acceptation de #45 : récapitulatif
 * et lien d'annulation.
 *
 * ## Ce que #1051 y change
 *
 * L'audit `d20260918-1` relève *« un encart vert de douze lignes de texte »*
 * ouvrant l'écran, la date du rendez-vous noyée dans une liste de définitions, et
 * *« trois actions dans trois styles différents »* — le moment « c'est réservé »
 * ne se voyait pas. L'écran est donc devenu ce que `BM-CONFIRM-01` décrit :
 *
 * - une **pastille** et un titre qui disent l'issue en un coup d'œil, suivis
 *   d'une seule phrase. Le statut annoncé est le statut réel (`outcomeOf`) ;
 * - la **carte du rendez-vous**, celle du récapitulatif qu'on vient de valider et
 *   celle de l'espace client : date en bloc, plage horaire, prestation,
 *   praticien, salon, total. À 360 px la date et l'heure sont au premier écran ;
 * - des actions **hiérarchisées** : « Ajouter à mon agenda » est le seul bouton
 *   plein (`BM-RDV-03`, `BM-VISUEL-02`), « Voir mes rendez-vous » est en contour,
 *   le reste est discret.
 *
 * Le fichier d'agenda n'a pas de route à lui : `appointmentIcsHref` (#1053) rend
 * une URL de données calculée au rendu, si bien que le lien sort complet du
 * serveur et fonctionne même si le script ne charge jamais. Ses `DTSTART` et
 * `DTEND` sont des **instants** UTC — la seule écriture qui désigne sans
 * ambiguïté l'heure du salon, quel que soit le fuseau de l'agenda qui l'ouvre
 * (ADR 0006).
 *
 * ## C'est une sortie, pas un cul-de-sac (#732)
 *
 * `docs/design/appointments/wireframes.md` — Étape 6 — prescrit des « prochaines
 * actions » : réserver à nouveau, et rejoindre le rendez-vous là où il se
 * modifie. L'écran n'offrait que « Annuler ce rendez-vous », si bien qu'un
 * visiteur revenu sur le tunnel dans la même session n'avait plus qu'un geste
 * disponible — et c'était le destructif.
 *
 * Le rouge ne disparaît pas pour autant : il est porté par « Confirmer
 * l'annulation », qui est le geste réellement destructif.
 *
 * Une fois le rendez-vous annulé, l'accent passe à « Réserver à nouveau » :
 * l'agenda n'a plus rien à recevoir, et c'est la seule action qui reste utile.
 *
 * ## L'annulation demande une confirmation
 *
 * Le geste est destructif et la fenêtre d'annulation d'un salon peut être
 * courte : un clic malheureux ne doit pas coûter le rendez-vous. La confirmation
 * est posée en ligne plutôt qu'en modale — elle tient en deux boutons, et une
 * `<dialog>` déplacerait le focus pour une question à laquelle la réponse est
 * juste au-dessous.
 *
 * ## Ce que cet écran n'est pas
 *
 * Il vit dans l'onglet de la réservation : c'est `sessionStorage` qui le fait
 * survivre à un rafraîchissement, pas une adresse. Le lien d'annulation
 * **durable**, celui qui part dans l'e-mail de confirmation et fonctionne des
 * jours plus tard, relève de la chaîne de notifications et de son ticket.
 *
 * Il ne demande donc plus qu'on le conserve (#736). « Conservez cette page :
 * c'est d'ici que vous pouvez annuler » promettait une permanence qu'un onglet
 * fermé emporte — et `notification-content.ts` dit l'inverse noir sur blanc en
 * expliquant où pointe le `{{lien_annulation}}` de l'e-mail : *« l'espace client
 * … est la seule surface web qui annule durablement »*.
 *
 * Il n'est pas non plus la source de vérité sur le rendez-vous. Le brouillon est
 * écrit une fois, à la réservation, et rien ne le relit ensuite : reporté ou
 * annulé depuis l'espace client, le rendez-vous continuait d'être annoncé ici
 * « enregistré », à son ancien horaire (#732). Le front n'a aucun moyen de le
 * savoir — le contrôleur public ne sert que la création, le report et
 * l'annulation, pas la lecture d'un rendez-vous. Tant que cette lecture n'existe
 * pas, l'écran **cesse d'affirmer** ce qu'il ne peut pas vérifier : `restored`
 * lui retire sa pastille, lui fait annoncer un instantané et renvoyer à l'espace
 * client, qui fait foi.
 */
export function ConfirmationStep({
  tenant,
  service,
  appointment,
  contact,
  restored,
  onCancelled,
  onRestart,
}: ConfirmationStepProps) {
  const [confirmingCancellation, setConfirmingCancellation] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCancelled = appointment.status === 'cancelled';
  const staffName =
    service?.staff.find((member) => member.id === appointment.staffId)?.displayName ?? null;
  const minutes = bookedMinutes(appointment);
  const outcome = outcomeOf(appointment, restored);

  /**
   * Ce que le fichier d'agenda a besoin de savoir.
   *
   * Composé ici plutôt que par `appointmentBrief`, qui résout ses noms dans un
   * **catalogue** : le tunnel n'en tient pas, il a déjà la prestation en main et
   * elle vaut `null` quand elle a quitté le catalogue public.
   */
  const brief: AppointmentBrief = {
    appointment,
    serviceName: service?.name ?? null,
    practitioner: staffName,
    durationMinutes: minutes ?? 0,
  };

  const cancel = async () => {
    if (cancelling) {
      return;
    }

    setCancelling(true);
    setError(null);

    const result = await cancelAppointmentAction(tenant.slug, appointment.id);

    if (result.ok) {
      onCancelled(result.data);
      setConfirmingCancellation(false);
    } else {
      setError(result.message);
    }

    setCancelling(false);
  };

  return (
    <section className="spa-booking__step" aria-label="Confirmation de votre réservation">
      {outcome === null ? (
        <Notification tone="info" title="Votre dernière réservation dans cet onglet">
          {/* Aucune promesse d'espace client ici : une cliente qui a réservé
              sans compte n'en a pas. La phrase se borne à ce qui est vrai — cet
              écran ne relit rien — et l'agenda du salon reste la seule autorité
              qu'on puisse lui nommer sans se tromper. */}
          <p>
            Ce récapitulatif date du moment où vous avez réservé : il n’a pas été relu depuis. Un
            report ou une annulation faits ailleurs n’y apparaissent pas — c’est l’agenda du salon
            qui fait foi.
          </p>
        </Notification>
      ) : (
        /* `role="status"` et non un simple bloc : l'étape qui vient de
           disparaître emportait le bouton cliqué, et rien n'annoncerait
           autrement à un lecteur d'écran ce qui s'est passé. C'est le rôle que
           portait la notification qu'il remplace. */
        <div className={`spa-booking__done spa-booking__done--${outcome.tone}`} role="status">
          {/* Décorative : le titre juste au-dessous dit la même chose en
              toutes lettres (WCAG 1.1.1). */}
          <span className="spa-booking__done-badge" aria-hidden="true">
            <Icon name={outcome.icon} />
          </span>
          <h2 className="spa-booking__done-title">{outcome.title}</h2>
          <p className="spa-booking__done-line">{outcome.line}</p>
        </div>
      )}

      <BookingAppointmentCard
        tenant={tenant}
        serviceName={service?.name ?? null}
        durationMinutes={minutes}
        staffName={staffName}
        startsAt={appointment.startsAt}
        // La borne de fin n'est passée que si l'intervalle est une durée : sur
        // un intervalle dégénéré, `bookedMinutes` rend `null` et la carte
        // afficherait « 09:00 – 09:00 », c'est-à-dire un rendez-vous qui finit
        // avant d'avoir commencé. L'heure de début seule est ce dont on est sûr.
        endsAt={minutes === null ? null : appointment.endsAt}
        price={appointment.price}
      />

      {/* « Réf. RDV-8F3K-27 », au mot près du wireframe — Étape 6. Ce n'est pas
          une ligne de méta atténuée : la référence est l'une des rares choses de
          cet écran qu'on recopie ou qu'on dicte, et `.spa-card__meta` la rendait
          au ton des informations de second plan.

          Elle vient de l'**API** (#796) : c'est la colonne
          `appointments.reference`, unique par établissement, que le contrat rend
          dans `BookedAppointment`. Elle n'est plus calculée ici à partir de
          l'identifiant (#736), et c'est ce qui la rend citable ailleurs — le
          tiroir du planning affiche la même, l'e-mail de confirmation la reprend,
          et `GET /appointments/reference/{…}` la résout.

          Plus de repli non plus : le champ est requis par
          `bookedAppointmentSchema`, donc un brouillon qui ne le porte pas
          n'arrive pas jusqu'ici — il est écarté à la relecture, comme toute
          forme que le contrat ne reconnaît plus.

          `data-appointment-id` porte l'identifiant que la ligne ne montre pas.
          Il n'a rien de secret — c'est la donnée du brouillon de cet onglet, et
          celle que l'annulation ci-dessous envoie déjà à l'API — mais il cesse
          d'occuper deux lignes de l'écran. Le parcours critique s'en sert pour
          retrouver en API le rendez-vous qu'il vient de prendre
          (`tests/e2e/support/scene.ts`). */}
      <p className="spa-booking__reference" data-appointment-id={appointment.id}>
        <span className="spa-booking__reference-term">Réf.</span>{' '}
        <strong className="spa-booking__reference-code">{appointment.reference}</strong>
      </p>

      {isCancelled ? null : (
        /* L'e-mail et l'espace client, en une ligne (#1051).

           C'était un paragraphe de six lignes ; ce qu'il disait d'indispensable
           tient en deux phrases. « Un e-mail récapitulatif » et non « de
           confirmation » : cet e-mail est l'accusé automatique du CDC §1.4, émis
           sur `appointment.created` (`appointments.service.ts`) — donc sur un
           rendez-vous encore `PENDING`. L'appeler « confirmation » sous une
           pastille « à confirmer par le salon » ferait croire que la
           confirmation attendue est déjà arrivée.

           L'espace client reste **conditionné** : une réservation d'invitée crée
           une fiche sans mot de passe, et `AuthService.register` refuse ensuite
           cette même adresse (`EMAIL_ALREADY_REGISTERED`). « Avec un compte
           client chez … » est donc la condition que la phrase porte, et non un
           détail de style — l'annulation de cet écran reste offerte plus bas,
           tant que l'onglet vit, pour celles qui n'ont pas de compte.

           « Un second quand le salon aura confirmé » depuis #800 : c'est le salon
           qui confirme, et `APPOINTMENT_CONFIRMED` part à ce moment-là. Le dire
           évite à la cliente de revenir guetter la pastille. */
        <p className="spa-booking__sent">
          Un e-mail récapitulatif part vers <strong>{contact.email}</strong>, et un second quand le
          salon aura confirmé. Avec un compte client chez {tenant.name}, ce rendez-vous se retrouve
          dans votre espace, d’où il se reporte et s’annule.
        </p>
      )}

      {error === null ? null : (
        <Notification tone="danger" title="L’annulation n’a pas abouti">
          <p>{error}</p>
        </Notification>
      )}

      {/* `.spa-booking__actions` et non `.spa-card__footer` : ce dernier écarte
          les deux boutons aux extrémités de la ligne, et « Confirmer
          l'annulation » se retrouvait à des centaines de pixels de « Garder mon
          rendez-vous » (#623). Une question et sa réponse se lisent côte à côte.

          Et la question posée écarte tout le reste : tant qu'elle attend sa
          réponse, aucune autre sortie n'est offerte. Deux boutons face à une
          question, et rien qui invite à passer à côté sans y répondre. */}
      <div className="spa-booking__actions">
        {confirmingCancellation ? (
          <>
            <Button
              variant="danger"
              loading={cancelling}
              loadingLabel="Annulation en cours…"
              onClick={() => {
                void cancel();
              }}
            >
              Confirmer l’annulation
            </Button>
            <Button
              variant="quiet"
              disabled={cancelling}
              onClick={() => {
                setConfirmingCancellation(false);
              }}
            >
              Garder mon rendez-vous
            </Button>
          </>
        ) : (
          <>
            {isCancelled ? null : (
              /* Le seul bouton plein de l'écran (`BM-VISUEL-02`), et c'est
                 `BM-RDV-03` qui lui donne ce rang : *« le rendez-vous rejoint
                 l'agenda du téléphone, ce qui réduit les oublis »*. Rien à
                 ajouter à un agenda quand le rendez-vous est annulé : le bouton
                 n'est alors pas rendu, plutôt que désactivé.

                 Un `<a download>` et non un bouton : c'est un fichier, il se
                 copie et s'ouvre comme n'importe quelle adresse, et le style de
                 bouton lui vient des classes du socle. */
              <a
                className="spa-button spa-button--accent"
                href={appointmentIcsHref({ brief, tenant })}
                download={appointmentIcsFilename(appointment)}
              >
                <span className="spa-button__label">Ajouter à mon agenda</span>
              </a>
            )}

            {/* Un lien et non un bouton : c'est une navigation, elle doit
                s'ouvrir dans un onglet et se copier comme n'importe quelle
                adresse. L'écran renvoie vers l'espace client faute de pouvoir se
                conserver lui-même — le wireframe, Étape 6, ordonne de la même
                façon « Modifier / annuler » avant « Réserver à nouveau ». */}
            <Link className="spa-button spa-button--neutral" href={accountPath(tenant.slug)}>
              Voir mes rendez-vous
            </Link>

            <Button variant={isCancelled ? 'accent' : 'quiet'} onClick={onRestart}>
              Réserver à nouveau
            </Button>

            {isCancelled ? null : (
              <Button
                variant="quiet"
                onClick={() => {
                  setError(null);
                  setConfirmingCancellation(true);
                }}
              >
                Annuler ce rendez-vous
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
