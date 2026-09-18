'use client';

import type { PublicService } from '@spa/shared';
import { useState } from 'react';

import { ServiceChoice } from '@/components/booking/service-choice';
import { BookingActionBar } from '@/components/booking/summary-bar';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';

/** Valeur du choix « premier disponible » — l'absence de préférence, pas un praticien. */
const FIRST_AVAILABLE = '';

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
 * ## La prestation se choisit en cartes, et le CTA tient le bas de l'écran (#741)
 *
 * Les deux écarts que l'audit `d20260916-1` a relevés ici tiennent au même
 * endroit — `docs/design/appointments/wireframes.md`, étape 1 puis « Structure
 * commune à toutes les étapes » :
 *
 * - le choix de la prestation est un `radiogroup` de cartes, et c'est
 *   [`ServiceChoice`](../../../../../components/booking/service-choice.tsx) qui
 *   le rend — le sélecteur qu'il remplace tronquait le prix à 360 px ;
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
 * Le choix du praticien reste un sélecteur : le wireframe en fait une étape à
 * part entière, avec ses propres cartes, et la déplacer sort d'un ticket qui
 * porte sur la lisibilité de l'étape 1.
 */
export function ServiceStep({
  services,
  selectedServiceId,
  selectedStaffId,
  onSubmit,
}: ServiceStepProps) {
  const [serviceId, setServiceId] = useState(selectedServiceId ?? FIRST_AVAILABLE);
  const [staffId, setStaffId] = useState(selectedStaffId ?? FIRST_AVAILABLE);

  const service = services.find((candidate) => candidate.id === serviceId) ?? null;
  const staff = service?.staff ?? [];

  return (
    <form
      className="spa-booking__step"
      onSubmit={(event) => {
        event.preventDefault();
        if (service !== null) {
          onSubmit(service.id, staffId === FIRST_AVAILABLE ? null : staffId);
        }
      }}
    >
      <ServiceChoice
        services={services}
        selectedServiceId={service?.id ?? null}
        onSelect={(chosen) => {
          setServiceId(chosen);
          // Le praticien retenu peut ne pas tenir la nouvelle prestation.
          setStaffId(FIRST_AVAILABLE);
        }}
      />

      <Select
        id="praticien"
        label="Praticien"
        value={staffId}
        disabled={service === null}
        hint="Sans préférence, le salon vous attribue le premier praticien disponible."
        emptyLabel={
          service !== null && staff.length === 0
            ? 'Aucun praticien ne propose cette prestation actuellement.'
            : undefined
        }
        onChange={(event) => {
          setStaffId(event.target.value);
        }}
      >
        <option value={FIRST_AVAILABLE}>Premier disponible</option>
        {staff.map((member) => (
          <option key={member.id} value={member.id}>
            {member.displayName}
          </option>
        ))}
      </Select>

      {/* Dernier enfant du formulaire, et c'est ce qui la rend collante : elle
          tient le bas de la fenêtre tant que la liste des prestations déborde,
          puis se pose au bas de la colonne dès qu'elle tient en entier.

          Sans rappel : le choix n'est pas encore *retenu* — il vit dans l'état
          de ce composant jusqu'à la soumission —, et une ligne alimentée par le
          brouillon annoncerait la prestation précédente pendant qu'on en
          désigne une autre. Les cartes portent déjà durée et prix (#741). */}
      <BookingActionBar>
        <Button type="submit" variant="accent" block disabled={service === null}>
          {service === null ? 'Choisir une prestation pour continuer' : 'Choisir un créneau'}
        </Button>
      </BookingActionBar>
    </form>
  );
}
