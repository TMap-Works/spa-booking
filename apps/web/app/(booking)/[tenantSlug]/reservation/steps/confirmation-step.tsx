'use client';

import type { BookedAppointment, PublicService, PublicTenant } from '@spa/shared';
import Link from 'next/link';
import { useState } from 'react';

// Le chemin de l'espace client vient de son propre module — le seul endroit du
// front qui sache comment cette adresse s'écrit. Le réécrire ici en ferait une
// seconde source de vérité, et `paths.ts` est justement bâti pour être importé
// par des Client Components : il ne dépend de rien du serveur (voir son en-tête).
import { accountPath } from '@/app/(account)/[tenantSlug]/compte/paths';
import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import type { ContactDraft } from '@/lib/booking/draft';

import { cancelAppointmentAction } from '../actions';

import { Recap } from './recap';

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

/**
 * Écran de confirmation — cinquième critère d'acceptation de #45 : récapitulatif
 * et lien d'annulation.
 *
 * ## C'est une sortie, pas un cul-de-sac (#732)
 *
 * `docs/design/appointments/wireframes.md` — Étape 6 — prescrit des « prochaines
 * actions » : réserver à nouveau, et rejoindre le rendez-vous là où il se
 * modifie. L'écran n'offrait que « Annuler ce rendez-vous », si bien qu'un
 * visiteur revenu sur le tunnel dans la même session n'avait plus qu'un geste
 * disponible — et c'était le destructif.
 *
 * Les trois actions ne sont donc pas de même rang : **« Voir mes rendez-vous »**
 * mène à l'espace client et porte l'accent (#736), **« Réserver à nouveau »**
 * repart d'un brouillon vierge, et **« Annuler ce rendez-vous »** passe en
 * `quiet`. Le rouge ne disparaît pas pour autant : il est reporté sur
 * « Confirmer l'annulation », qui est le geste réellement destructif.
 *
 * L'accent a changé de main avec #736, et pas par goût : cet écran ne se
 * conserve pas — voir « Ce que cet écran n'est pas » plus bas —, si bien que la
 * sortie qu'il doit mettre en avant est celle qui mène là où le rendez-vous vit
 * encore une fois l'onglet fermé.
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
 * … est la seule surface web qui annule durablement : l'écran de confirmation du
 * tunnel de réservation le fait aussi, mais il vit dans le `sessionStorage` de
 * l'onglet et ne survit pas à sa fermeture »*. Les deux surfaces nomment
 * désormais la même autorité.
 *
 * Il n'est pas non plus la source de vérité sur le rendez-vous. Le brouillon est
 * écrit une fois, à la réservation, et rien ne le relit ensuite : reporté ou
 * annulé depuis l'espace client, le rendez-vous continuait d'être annoncé ici
 * « enregistré », à son ancien horaire (#732). Le front n'a aucun moyen de le
 * savoir — le contrôleur public ne sert que la création, le report et
 * l'annulation, pas la lecture d'un rendez-vous. Tant que cette lecture n'existe
 * pas, l'écran **cesse d'affirmer** ce qu'il ne peut pas vérifier : `restored`
 * le fait annoncer un instantané et renvoyer à l'espace client, qui fait foi.
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
      {isCancelled ? (
        <Notification tone="info" title="Votre rendez-vous est annulé">
          <p>
            Il ne figure plus à l’agenda du salon. Vous pouvez en prendre un nouveau quand vous le
            souhaitez.
          </p>
        </Notification>
      ) : restored ? (
        <Notification tone="info" title="Votre dernière réservation dans cet onglet">
          {/* Aucune promesse d'espace client ici non plus, et pour la raison que
              dit le message de succès : une cliente qui a réservé sans compte
              n'en a pas. La phrase se borne à ce qui est vrai — cet écran ne
              relit rien — et l'agenda du salon reste la seule autorité qu'on
              puisse lui nommer sans se tromper. */}
          <p>
            Ce récapitulatif date du moment où vous avez réservé : il n’a pas été relu depuis. Un
            report ou une annulation faits ailleurs n’y apparaissent pas — c’est l’agenda du salon
            qui fait foi.
          </p>
        </Notification>
      ) : (
        <Notification tone="success" title="Votre rendez-vous est enregistré">
          {/* L'espace client est nommé, mais il reste conditionné : une
              réservation d'invitée crée une fiche sans mot de passe, et
              `AuthService.register` refuse ensuite cette même adresse
              (`EMAIL_ALREADY_REGISTERED`). « Avec un compte client chez … » est
              donc la condition que la phrase porte, et non un détail de style —
              l'annulation de cet écran reste offerte plus bas, tant que
              l'onglet vit, pour celles qui n'ont pas de compte.

              Ce que la phrase ne dit plus, c'est de conserver la page : elle
              promettait une permanence que la fermeture de l'onglet emporte.
              Mais elle protégeait quelque chose — le seul recours de qui n'a pas
              de compte —, et la dernière phrase le reprend à son compte : elle
              nomme le bouton qui est juste au-dessous, et la durée pendant
              laquelle il existe, au lieu de demander de garder un onglet
              ouvert. */}
          <p>
            Un e-mail de confirmation part vers {contact.email}. Avec un compte client chez{' '}
            {tenant.name}, ce rendez-vous se retrouve dans votre espace, d’où il se reporte et
            s’annule. Sans compte, vous pouvez encore l’annuler ci-dessous, tant que cet onglet
            reste ouvert.
          </p>
        </Notification>
      )}

      <Recap
        tenant={tenant}
        serviceName={service?.name ?? null}
        durationMinutes={bookedMinutes(appointment)}
        staffName={staffName}
        startsAt={appointment.startsAt}
        price={appointment.price}
        contact={contact}
      />

      {/* « Réf. RDV-8F3K-27 », au mot près du wireframe — Étape 6. Ce n'est pas
          une ligne de méta atténuée : la référence est l'une des rares choses de
          cet écran qu'on recopie ou qu'on dicte, et `.spa-card__meta` la rendait
          au ton des informations de second plan.

          Elle vient désormais de l'**API** (#796) : c'est la colonne
          `appointments.reference`, unique par établissement, que le contrat
          rend dans `BookedAppointment`. Elle n'est plus calculée ici à partir de
          l'identifiant (#736), et c'est ce qui la rend citable ailleurs — le
          tiroir du planning affiche la même, l'e-mail de confirmation la reprend,
          et `GET /appointments/reference/{…}` la résout. Une référence que seul
          cet écran savait produire ne servait qu'à reconnaître ; celle-ci sert à
          en parler.

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
          réponse, « Réserver à nouveau » et « Voir mes rendez-vous » ne sont pas
          offerts. Deux boutons face à une question, et rien qui invite à passer
          à côté sans y répondre. */}
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
            {/* Un lien et non un bouton : c'est une navigation, elle doit
                s'ouvrir dans un onglet et se copier comme n'importe quelle
                adresse. Le style de bouton lui vient des classes du socle,
                comme pour le retour de `report/not-found.tsx`.

                Et c'est lui qui porte l'accent (#736). L'écran renvoie vers
                l'espace client faute de pouvoir se conserver lui-même : la
                sortie principale est donc celle qui mène là où le rendez-vous
                vit encore demain, pas celle qui en ouvre un second. Le
                wireframe — Étape 6 — les ordonne de la même façon,
                « Modifier / annuler » avant « Réserver à nouveau ». */}
            <Link className="spa-button spa-button--accent" href={accountPath(tenant.slug)}>
              Voir mes rendez-vous
            </Link>
            <Button variant="neutral" onClick={onRestart}>
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
