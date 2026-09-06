'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { longTextSchema } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { TextArea } from '@/components/ui/textarea';

import { updateCustomerAction } from '../actions';

/**
 * La note interne d'une fiche — troisième critère de #54.
 *
 * ## « Interne » est écrit, pas suggéré
 *
 * Une note du type « arrive systématiquement en retard » est utile au salon et
 * désastreuse si elle fuit. L'écran le dit donc **en toutes lettres**, à côté du
 * titre et sous le champ, plutôt que par une teinte — la seule garantie qui
 * survive à un daltonisme, à une impression en gris, et à un opérateur qui
 * tourne son écran vers la cliente. Le doute sur ce point conduirait à ne plus
 * rien écrire, et la fonctionnalité perdrait son intérêt.
 *
 * Ce que l'écran affirme, l'API le tient : `internalNote` n'est portée que par
 * `customerSchema`, servi au rang `staff`. Ni la liste, ni aucun schéma du
 * parcours public ne la référencent — il n'existe aucune route par laquelle
 * elle pourrait sortir vers une cliente.
 *
 * ## Une seule note, et non un fil
 *
 * `users.internal_note` est **un** texte, remplacé à chaque enregistrement : ce
 * qui est écrit ici prend la place de ce qui y était. La maquette de #30
 * montrait un fil horodaté et signé ; il demanderait une table de notes, donc
 * une migration et une décision de produit — c'est une issue, pas une ligne de
 * code d'ici. Le champ est donc pré-rempli avec la note existante, et le dire
 * évite qu'on croie ajouter alors qu'on remplace.
 */

const noteFormSchema = z.object({ internalNote: longTextSchema });

type NoteFormValues = z.input<typeof noteFormSchema>;

interface ClientNoteFormProps {
  readonly tenantSlug: string;
  readonly customerId: string;
  /** La note en place, ou `null` quand la fiche n'en porte aucune. */
  readonly internalNote: string | null;
}

export function ClientNoteForm({ tenantSlug, customerId, internalNote }: ClientNoteFormProps) {
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NoteFormValues, unknown, z.output<typeof noteFormSchema>>({
    resolver: zodResolver(noteFormSchema),
    defaultValues: { internalNote: internalNote ?? '' },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    setSaved(false);

    const result = await updateCustomerAction(tenantSlug, customerId, {
      // `null` est la valeur par laquelle on **efface** ; la chaîne vide
      // descendrait jusqu'à la colonne comme une note d'un caractère nul, que la
      // fiche afficherait ensuite comme une note existante et vide.
      internalNote: values.internalNote === '' ? null : values.internalNote,
    });

    if (!result.ok) {
      setFailure(result.message);
      return;
    }

    setSaved(true);
    // La fiche est rendue côté serveur : sans ce rafraîchissement, la note
    // enregistrée resterait celle d'avant partout ailleurs sur l'écran.
    router.refresh();
  });

  return (
    <div className="spa-admin-notes">
      <h3 className="spa-admin__section-title">
        Note interne <span className="spa-admin-notes__private">Interne au salon</span>
      </h3>

      {saved ? (
        <Notification tone="success" title="Note enregistrée">
          <p>Elle n’est visible que du personnel du salon.</p>
        </Notification>
      ) : null}

      {failure === null ? null : (
        <Notification tone="danger" title="L’enregistrement a échoué">
          <p>{failure}</p>
        </Notification>
      )}

      <form onSubmit={(event) => void submit(event)} noValidate>
        <TextArea
          id={`client-note-${customerId}`}
          label="Note interne"
          rows={4}
          hint="Préférences, allergies, sensibilités. Jamais transmise à la cliente — ni dans un e-mail, ni dans un SMS. Enregistrer remplace la note précédente ; vider le champ l’efface."
          error={errors.internalNote?.message}
          {...register('internalNote')}
        />
        <Button
          type="submit"
          variant="accent"
          loading={isSubmitting}
          loadingLabel="Enregistrement…"
        >
          Enregistrer la note
        </Button>
      </form>

      {internalNote === null ? (
        <div className="spa-empty-state spa-empty-state--inline">
          <p className="spa-empty-state__title">Aucune note pour l’instant</p>
          <p className="spa-empty-state__description">
            Ce qui aide à mieux recevoir la prochaine fois se note ici, et n’est lu que par le
            salon.
          </p>
        </div>
      ) : (
        <ul className="spa-admin-notes__list">
          <li className="spa-admin-notes__item">
            <div className="spa-admin-notes__meta">
              <span>Note en place</span>
              <span>Visible du personnel du salon uniquement</span>
            </div>
            <p className="spa-admin-notes__body">{internalNote}</p>
          </li>
        </ul>
      )}
    </div>
  );
}
