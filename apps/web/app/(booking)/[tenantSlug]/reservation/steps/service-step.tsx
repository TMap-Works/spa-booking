'use client';

import type { PublicService } from '@spa/shared';
import { useState } from 'react';

import { ServiceChoice } from '@/components/booking/service-choice';
import { StaffChoice } from '@/components/booking/staff-choice';
import { BookingActionBar } from '@/components/booking/summary-bar';
import { Button } from '@/components/ui/button';

interface ServiceStepProps {
  readonly services: readonly PublicService[];
  readonly selectedServiceId: string | null;
  readonly selectedStaffId: string | null;
  readonly onSubmit: (serviceId: string, staffId: string | null) => void;
}

/**
 * Choix de la prestation et du praticien.
 *
 * L'option « premier disponible » est nommée par le CDC §1.4 et n'est pas une
 * valeur manquante : elle dit que la cliente n'a pas de préférence, et c'est le
 * serveur qui affecte le praticien à la réservation. Le front ne choisit donc
 * jamais à sa place — il déciderait sur un agenda déjà périmé.
 *
 * ## La prestation se choisit en lignes, et le CTA tient le bas de l'écran (#741, #1048)
 *
 * Les deux écarts que l'audit `d20260916-1` a relevés ici tiennent au même
 * endroit — `docs/design/appointments/wireframes.md`, étape 1 puis « Structure
 * commune à toutes les étapes » :
 *
 * - le choix de la prestation est un `radiogroup`, et c'est
 *   [`ServiceChoice`](../../../../../components/booking/service-choice.tsx) qui
 *   le rend — le sélecteur qu'il remplace tronquait le prix à 360 px. #1048 y a
 *   ajouté les rubriques en onglets et le format de ligne de la vitrine ;
 * - *« le CTA primaire pleine largeur »* est *« ancré en bas de l'écran (barre
 *   collante) »*, *« le contenu défile derrière »*. C'est `BookingActionBar`
 *   ci-dessous, la barre basse commune à toutes les étapes depuis #1047.
 *
 * Le libellé du bouton dit **pourquoi** il est désactivé tant que rien n'est
 * retenu, comme le wireframe le demande (« Le CTA est désactivé tant que l'étape
 * n'est pas valide, avec un libellé qui dit pourquoi »). Une barre pleine largeur
 * posée en travers de l'écran et inerte, sans un mot, se lit sinon comme une
 * panne.
 *
 * ## Le praticien se choisit sur place, et sans liste déroulante (#1048)
 *
 * Le wireframe en faisait une étape à part entière ; le tunnel du MVP n'en a que
 * quatre, et l'audit `d20260918-1` relève la `<select>` grisée qui en tenait
 * lieu. Elle a laissé place à une rangée de cartes
 * ([`StaffChoice`](../../../../../components/booking/staff-choice.tsx)), qui ne
 * paraît qu'**une fois la prestation retenue** : une liste de praticiens sans
 * prestation ne veut rien dire, et un contrôle grisé posé sous la liste se lit
 * comme une panne plutôt que comme une étape à venir.
 */
export function ServiceStep({
  services,
  selectedServiceId,
  selectedStaffId,
  onSubmit,
}: ServiceStepProps) {
  const [serviceId, setServiceId] = useState<string | null>(selectedServiceId);
  const [staffId, setStaffId] = useState<string | null>(selectedStaffId);

  const service = services.find((candidate) => candidate.id === serviceId) ?? null;

  /**
   * Le praticien retenu, **rapporté à la prestation retenue**.
   *
   * Le brouillon relu de l'URL ou de `sessionStorage` porte un `staffId` que rien
   * n'oblige à tenir la prestation : un lien partagé peut nommer les deux sans
   * qu'ils aillent ensemble. Sans cette remise à `null`, aucune carte ne serait
   * cochée — pas même « Premier disponible » —, et la soumission relaierait
   * pourtant l'identifiant orphelin à l'étape du créneau, qui interrogerait
   * l'agenda d'un praticien qui ne propose pas ce soin. C'est la même lecture que
   * celle du rappel (`booking-tunnel.tsx`), qui n'y trouve déjà aucun nom.
   */
  const staff = service?.staff ?? [];
  const effectiveStaffId =
    staffId !== null && staff.some((member) => member.id === staffId) ? staffId : null;

  return (
    <form
      className="spa-booking__step"
      onSubmit={(event) => {
        event.preventDefault();
        if (service !== null) {
          onSubmit(service.id, effectiveStaffId);
        }
      }}
    >
      <ServiceChoice
        services={services}
        selectedServiceId={service?.id ?? null}
        onSelect={(chosen) => {
          setServiceId(chosen);
          // Le praticien retenu peut ne pas tenir la nouvelle prestation.
          setStaffId(null);
        }}
      />

      {service === null ? null : (
        <StaffChoice
          staff={service.staff}
          value={effectiveStaffId}
          onSelect={(chosen) => {
            setStaffId(chosen);
          }}
        />
      )}

      {/* Dernier enfant du formulaire, et c'est ce qui la rend collante : elle
          tient le bas de la fenêtre tant que la liste des prestations déborde,
          puis se pose au bas de la colonne dès qu'elle tient en entier.

          Sans rappel : le choix n'est pas encore *retenu* — il vit dans l'état
          de ce composant jusqu'à la soumission —, et une ligne alimentée par le
          brouillon annoncerait la prestation précédente pendant qu'on en
          désigne une autre. Les lignes portent déjà durée et prix (#741). */}
      <BookingActionBar>
        <Button type="submit" variant="accent" block disabled={service === null}>
          {service === null ? 'Choisissez une prestation' : 'Choisir un créneau'}
        </Button>
      </BookingActionBar>
    </form>
  );
}
