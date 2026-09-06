'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { nameSchema, phoneSchema, type Customer } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';

import { updateCustomerAction } from '../actions';

/**
 * Correction des coordonnées d'une fiche — deuxième critère de #54.
 *
 * ## Replié par défaut
 *
 * La fiche s'ouvre pour être **lue** : le comptoir a la cliente au bout du fil
 * et cherche un numéro, pas un formulaire. L'édition est donc derrière un
 * bouton, comme sur la maquette — et le formulaire n'existe pas dans le DOM tant
 * qu'on ne l'a pas demandé, ce qui évite qu'une frappe distraite modifie la
 * fiche qu'on regardait.
 *
 * ## L'adresse est affichée, jamais modifiable
 *
 * Elle est la clé de `@@unique([tenantId, email])` et l'identifiant de
 * connexion : la changer demande de vérifier la nouvelle, ce que le périmètre
 * MVP ne prévoit pas. `updateCustomerRequestSchema` ne la porte pas et l'API
 * refuse en 400 le corps qui l'y glisserait — ce champ est donc en lecture
 * seule, avec la raison écrite à côté plutôt qu'une absence inexpliquée. Même
 * arbitrage que les coordonnées de l'espace client.
 *
 * De même pour l'activation : désactiver une fiche est une décision **sur** le
 * fichier et non une correction **dedans**, elle a sa propre route au rang
 * `manager`, et aucun critère de ce ticket ne la demande.
 */

const contactFormSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema,
  phone: z.union([z.literal(''), phoneSchema]),
});

type ContactFormValues = z.input<typeof contactFormSchema>;

interface ClientContactFormProps {
  readonly tenantSlug: string;
  readonly customer: Customer;
}

export function ClientContactForm({ tenantSlug, customer }: ClientContactFormProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormValues, unknown, z.output<typeof contactFormSchema>>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: {
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone ?? '',
    },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    setSaved(false);

    const result = await updateCustomerAction(tenantSlug, customer.id, {
      firstName: values.firstName,
      lastName: values.lastName,
      // `null` efface le numéro ; la chaîne vide n'est pas une valeur du contrat.
      phone: values.phone === '' ? null : values.phone,
    });

    if (!result.ok) {
      setFailure(result.message);
      return;
    }

    setSaved(true);
    setOpen(false);
    // Le nom et le numéro sont rendus côté serveur, dans l'en-tête de la fiche
    // et dans la liste de gauche : sans ce rafraîchissement, les deux
    // resteraient ceux d'avant.
    router.refresh();
  });

  if (!open) {
    return (
      <>
        {saved ? (
          <Notification tone="success" title="Coordonnées enregistrées">
            <p>Les prochaines confirmations partiront sur ces coordonnées.</p>
          </Notification>
        ) : null}
        <Button
          variant="neutral"
          onClick={() => {
            setSaved(false);
            setOpen(true);
          }}
        >
          Modifier les coordonnées
        </Button>
      </>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      {failure === null ? null : (
        <Notification tone="danger" title="L’enregistrement a échoué">
          <p>{failure}</p>
        </Notification>
      )}

      <Field
        id={`client-first-name-${customer.id}`}
        label="Prénom"
        autoComplete="off"
        required
        error={errors.firstName?.message}
        {...register('firstName')}
      />
      <Field
        id={`client-last-name-${customer.id}`}
        label="Nom"
        autoComplete="off"
        required
        error={errors.lastName?.message}
        {...register('lastName')}
      />
      <Field
        id={`client-phone-${customer.id}`}
        label="Téléphone"
        type="tel"
        autoComplete="off"
        hint="Laissez vide pour retirer le numéro — le rappel J-1 partira alors par e-mail seulement."
        error={errors.phone?.message}
        {...register('phone')}
      />
      <Field
        id={`client-email-${customer.id}`}
        label="Adresse e-mail"
        type="email"
        value={customer.email}
        readOnly
        hint="Identifiant de la fiche dans ce salon. Le MVP ne sait pas encore vérifier une nouvelle adresse : elle ne se modifie pas ici."
      />

      <Button type="submit" variant="accent" loading={isSubmitting} loadingLabel="Enregistrement…">
        Enregistrer
      </Button>
      <Button
        variant="quiet"
        onClick={() => {
          setOpen(false);
        }}
      >
        Annuler
      </Button>
    </form>
  );
}
