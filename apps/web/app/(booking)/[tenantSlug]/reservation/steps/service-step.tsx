'use client';

import type { PublicService } from '@spa/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { formatDuration, formatMoney } from '@/lib/format';

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
      onSubmit={(event) => {
        event.preventDefault();
        if (service !== null) {
          onSubmit(service.id, staffId === FIRST_AVAILABLE ? null : staffId);
        }
      }}
    >
      <Select
        id="prestation"
        label="Prestation"
        value={serviceId}
        emptyLabel={
          services.length === 0
            ? 'Ce salon ne propose aucune prestation en ligne pour le moment.'
            : undefined
        }
        onChange={(event) => {
          setServiceId(event.target.value);
          // Le praticien retenu peut ne pas tenir la nouvelle prestation.
          setStaffId(FIRST_AVAILABLE);
        }}
      >
        <option value={FIRST_AVAILABLE}>Choisir une prestation…</option>
        {services.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.name} — {formatDuration(candidate.durationMinutes)} —{' '}
            {formatMoney(candidate.price)}
          </option>
        ))}
      </Select>

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

      <Button type="submit" variant="accent" disabled={service === null}>
        Choisir un créneau
      </Button>
    </form>
  );
}
