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
 * Les trois actions ne sont donc pas de même rang : **« Réserver à nouveau »**
 * repart d'un brouillon vierge, **« Voir mes rendez-vous »** mène à l'espace
 * client, et **« Annuler ce rendez-vous »** passe en `quiet`. Le rouge ne
 * disparaît pas pour autant : il est reporté sur « Confirmer l'annulation », qui
 * est le geste réellement destructif.
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
          {/* La page reste nommée comme surface d'annulation, et l'espace client
              n'est pas promis : une réservation d'invitée crée une fiche sans
              mot de passe, et `AuthService.register` refuse ensuite cette même
              adresse (`EMAIL_ALREADY_REGISTERED`). Annoncer « vous le
              retrouverez dans votre espace client » à qui n'a pas de compte,
              tout en retirant le seul chemin qui marche, laisserait la cliente
              sans aucune façon d'annuler dès l'onglet fermé. */}
          <p>
            Un e-mail de confirmation part vers {contact.email}. Conservez cette page : c’est d’ici
            que vous pouvez annuler. Avec un compte client chez {tenant.name}, vous le retrouverez
            aussi dans votre espace, d’où il peut être reporté.
          </p>
        </Notification>
      )}

      <Recap
        tenant={tenant}
        serviceName={service?.name ?? null}
        staffName={staffName}
        startsAt={appointment.startsAt}
        price={appointment.price}
        contact={contact}
      />

      <p className="spa-card__meta">Référence : {appointment.id}</p>

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
            <Button variant="accent" onClick={onRestart}>
              Réserver à nouveau
            </Button>
            {/* Un lien et non un bouton : c'est une navigation, elle doit
                s'ouvrir dans un onglet et se copier comme n'importe quelle
                adresse. Le style de bouton lui vient des classes du socle,
                comme pour le retour de `report/not-found.tsx`. */}
            <Link className="spa-button spa-button--neutral" href={accountPath(tenant.slug)}>
              Voir mes rendez-vous
            </Link>
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
