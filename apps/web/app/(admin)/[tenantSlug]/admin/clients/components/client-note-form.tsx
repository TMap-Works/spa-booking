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
import { useAdminSessionRenewal } from '../../components/use-admin-session-renewal';

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
 *
 * ## Et donc : la note ne se nomme qu'une fois — #763
 *
 * L'écran l'écrivait trois fois de suite — titre de section, libellé du champ,
 * puis un bloc « Note en place · Visible du personnel du salon uniquement » qui
 * **recopiait le texte déjà affiché dans le champ**, deux centimètres plus haut.
 * Ce dernier venait de la maquette à fil : avec plusieurs notes horodatées il
 * montrait l'historique ; avec une note unique et un champ pré-rempli, il ne
 * montrait que le doublon de ce qu'on était en train d'éditer — et laissait
 * croire à deux objets là où il n'y en a qu'un, jusqu'à faire chercher lequel
 * des deux fait foi.
 *
 * Ce qui subsiste se répartit donc sans se répéter :
 *
 * - le **titre** nomme la section et porte la mention « Interne au salon » —
 *   c'est le motif de `styles/admin/README.md`, et la seule mention du nom ;
 * - le **libellé du champ** dit ce qu'on y écrit, et non comment la section
 *   s'appelle : un libellé qui répète son titre n'apprend rien à qui le lit, et
 *   il est en outre ce qu'un lecteur d'écran annonce juste après lui ;
 * - la **légende** garde les deux garanties qui décident si l'on ose écrire :
 *   rien ne part vers le client, et enregistrer remplace.
 *
 * Le champ pré-rempli est ce qui rend la note en place lisible ; il n'y a rien à
 * afficher en plus, ni quand elle existe, ni quand elle manque.
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
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
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
      if (renewIfExpired(result)) {
        return;
      }
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
          label="Ce que le salon doit savoir"
          rows={4}
          hint="Préférences, allergies, sensibilités. Jamais transmise au client — ni dans un e-mail, ni dans un SMS. Enregistrer remplace la note précédente ; vider le champ l’efface."
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
    </div>
  );
}
