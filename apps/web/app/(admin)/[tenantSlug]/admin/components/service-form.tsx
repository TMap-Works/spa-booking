'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  displayNameSchema,
  longTextSchema,
  slugSchema,
  type CreateServiceRequest,
  type Service,
  type ServiceCategory,
  type UpdateServiceRequest,
} from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { TextArea } from '@/components/ui/textarea';
import { formatAmountInput, formatDuration, parseAmountInput } from '@/lib/format';

import { adminServicePath } from '../paths';
import { createServiceAction, updateServiceAction } from '../catalogue/actions';

/**
 * Création et modification d'une prestation (#52, critères 1 et 3).
 *
 * ## Un seul formulaire pour les deux gestes
 *
 * Les champs sont les mêmes, les règles sont les mêmes, et les tenir en deux
 * composants garantirait qu'une validation ajoutée à l'un manque à l'autre.
 * Trois choses seulement diffèrent : le titre, le libellé du bouton, et ce qui
 * se passe après — la création ouvre la fiche de la prestation, pour que
 * l'affectation des praticiens s'enchaîne.
 *
 * ## Le prix ne passe jamais par un flottant
 *
 * La saisie est une chaîne (« 35,00 »), convertie par `parseAmountInput` en
 * entier de plus petite unité **par concaténation de chiffres**, jamais par une
 * multiplication. La devise est celle de l'établissement, lue sur ses réglages :
 * elle n'est pas saisissable ici, parce qu'un salon vend dans une seule monnaie
 * et qu'un choix par prestation ne ferait qu'ouvrir la porte à un catalogue
 * mélangé — donc à des totaux impossibles à additionner.
 *
 * ## Ce que la durée bloquée montre, et pourquoi elle n'est pas saisissable
 *
 * `occupiedMinutes` est la somme de la durée et des deux tampons. L'API la
 * calcule et ne la stocke pas ; l'écran la recalcule pour l'afficher **pendant
 * la saisie**, parce que c'est la valeur qui décide de l'agenda et qu'une
 * gérante doit la voir avant d'enregistrer. Elle reste en lecture seule : un
 * quatrième champ divergerait de ses trois termes au premier enregistrement
 * partiel.
 */

/** Chaîne d'entiers positifs — le contrôle le plus proche de la saisie réelle. */
const digitsSchema = z.string().trim().regex(/^\d+$/, { message: 'nombre entier de minutes attendu' });

/**
 * Le schéma de la **saisie**, construit autour de la devise du salon.
 *
 * Il diffère des contrats de `@spa/shared` sur un point : la chaîne vide y est
 * licite là où un champ est facultatif, parce qu'un champ de formulaire vidé est
 * vide et non absent. La conversion se fait à l'envoi, et l'action serveur
 * revalide derrière avec le vrai contrat.
 */
function serviceFormSchema(currency: string) {
  return z.object({
    name: displayNameSchema,
    slug: z.union([z.literal(''), slugSchema]),
    description: longTextSchema,
    categoryId: z.string(),
    durationMinutes: digitsSchema.refine((value) => Number(value) >= 1, {
      message: 'une durée doit être strictement positive',
    }),
    // Zéro est le cas courant — un soin sans temps de préparation — et le champ
    // vide vaut zéro. Négatif n'existe pas : un tampon négatif rendrait la
    // cabine disponible avant la fin réelle du soin.
    bufferBeforeMinutes: z.union([z.literal(''), digitsSchema]),
    bufferAfterMinutes: z.union([z.literal(''), digitsSchema]),
    price: z.string().refine((value) => parseAmountInput(value, currency) !== null, {
      message: 'montant attendu dans la devise du salon (« 35,00 »)',
    }),
  });
}

type ServiceFormValues = z.input<ReturnType<typeof serviceFormSchema>>;

interface ServiceFormProps {
  readonly tenantSlug: string;
  /** Devise de l'établissement — `defaultCurrency` de ses réglages. */
  readonly currency: string;
  /** Rubriques proposées au classement. Les désactivées n'y figurent pas. */
  readonly categories: readonly ServiceCategory[];
  /** Absente, le formulaire crée ; présente, il modifie. */
  readonly service?: Service;
}

/**
 * Minutes d'un champ : vide vaut zéro, et une saisie en cours de frappe aussi.
 *
 * Le second cas compte : l'aperçu de la durée bloquée se recalcule à chaque
 * touche, et `Number('6 ')` ou `Number('abc')` y ferait apparaître un `NaN` en
 * plein écran pendant que la gérante tape. Le schéma, lui, refuse la saisie au
 * moment de valider — c'est là que la faute se dit, pas dans un compteur.
 */
function minutesOf(value: string): number {
  const digits = value.trim();
  return /^\d+$/.test(digits) ? Number(digits) : 0;
}

export function ServiceForm({ tenantSlug, currency, categories, service }: ServiceFormProps) {
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const schema = useMemo(() => serviceFormSchema(currency), [currency]);

  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ServiceFormValues, unknown, z.output<ReturnType<typeof serviceFormSchema>>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: service?.name ?? '',
      slug: service?.slug ?? '',
      description: service?.description ?? '',
      categoryId: service?.category?.id ?? '',
      durationMinutes: service === undefined ? '' : String(service.durationMinutes),
      bufferBeforeMinutes: service === undefined ? '' : String(service.bufferBeforeMinutes),
      bufferAfterMinutes: service === undefined ? '' : String(service.bufferAfterMinutes),
      price: service === undefined ? '' : formatAmountInput(service.price),
    },
    mode: 'onTouched',
  });

  // Recalculée à chaque frappe : c'est la durée que l'agenda bloquera, et la
  // voir avant d'enregistrer évite de découvrir après coup pourquoi le créneau
  // suivant n'est pas libre à l'heure attendue.
  const [duration, bufferBefore, bufferAfter] = watch([
    'durationMinutes',
    'bufferBeforeMinutes',
    'bufferAfterMinutes',
  ]);
  const occupied = minutesOf(duration) + minutesOf(bufferBefore) + minutesOf(bufferAfter);

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    setSaved(false);

    const price = parseAmountInput(values.price, currency);

    if (price === null) {
      // Le schéma l'a déjà refusé ; ce garde-fou existe parce qu'une exception
      // levée dans ce rappel remonterait telle quelle depuis `handleSubmit` —
      // l'écran n'afficherait rien, le bouton reprendrait son état de repos, et
      // rien n'aurait été enregistré. Un échec muet est la pire des réponses.
      setError('price', { message: 'montant attendu dans la devise du salon (« 35,00 »)' });
      return;
    }

    const common = {
      name: values.name,
      durationMinutes: Number(values.durationMinutes),
      bufferBeforeMinutes: minutesOf(values.bufferBeforeMinutes),
      bufferAfterMinutes: minutesOf(values.bufferAfterMinutes),
      price,
    };

    const result =
      service === undefined
        ? await createServiceAction(tenantSlug, {
            ...common,
            // À la création, `undefined` vaut « laisse le serveur décider » : il
            // dérive le slug du nom, et une prestation non classée est licite.
            ...(values.slug === '' ? {} : { slug: values.slug }),
            ...(values.description === '' ? {} : { description: values.description }),
            ...(values.categoryId === '' ? {} : { categoryId: values.categoryId }),
          } satisfies CreateServiceRequest)
        : await updateServiceAction(tenantSlug, service.id, {
            ...common,
            slug: values.slug === '' ? service.slug : values.slug,
            // `null` **efface** ; la chaîne vide descendrait jusqu'à la colonne
            // comme une description d'un caractère nul.
            description: values.description === '' ? null : values.description,
            categoryId: values.categoryId === '' ? null : values.categoryId,
          } satisfies UpdateServiceRequest);

    if (!result.ok) {
      if (result.code === ERROR_CODES.CONFLICT) {
        // Le conflit ne peut venir que du slug : c'est la seule unicité que
        // porte la table. Le message se pose donc sur le champ qui se corrige,
        // pas en bandeau au-dessus du formulaire.
        setError('slug', { message: 'une autre prestation porte déjà cette adresse.' });
        return;
      }
      setFailure(result.message);
      return;
    }

    if (service === undefined) {
      router.push(adminServicePath(tenantSlug, result.data.id));
      return;
    }

    setSaved(true);
    // La page est rendue côté serveur : sans ce rafraîchissement, elle
    // continuerait d'afficher les valeurs d'avant l'enregistrement.
    router.refresh();
  });

  return (
    <form className="spa-admin__section" onSubmit={(event) => void submit(event)} noValidate>
      {saved ? (
        <Notification tone="success" title="Prestation enregistrée">
          <p>Le catalogue public reflète désormais ces informations.</p>
        </Notification>
      ) : null}

      {failure === null ? null : (
        <Notification tone="danger" title="L’enregistrement a échoué">
          <p>{failure}</p>
        </Notification>
      )}

      <Field
        id="service-name"
        label="Nom de la prestation"
        required
        error={errors.name?.message}
        {...register('name')}
      />

      <TextArea
        id="service-description"
        label="Description"
        hint="Affichée sur la page publique, sous le nom de la prestation. Facultative."
        error={errors.description?.message}
        {...register('description')}
      />

      <Select
        id="service-category"
        label="Rubrique"
        hint="Regroupe la prestation sur la page publique. « Non classée » est un choix valide."
        error={errors.categoryId?.message}
        {...register('categoryId')}
      >
        <option value="">Non classée</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </Select>

      <Field
        id="service-duration"
        label="Durée du soin (minutes)"
        required
        inputMode="numeric"
        placeholder="60"
        hint="Ce que la cliente voit et paie, tampons exclus."
        error={errors.durationMinutes?.message}
        {...register('durationMinutes')}
      />

      <Field
        id="service-buffer-before"
        label="Tampon avant (minutes)"
        inputMode="numeric"
        placeholder="0"
        hint="Préparation de la cabine. Invisible de la cliente, occupée sur l’agenda."
        error={errors.bufferBeforeMinutes?.message}
        {...register('bufferBeforeMinutes')}
      />

      <Field
        id="service-buffer-after"
        label="Tampon après (minutes)"
        inputMode="numeric"
        placeholder="0"
        hint="Remise en état. Invisible de la cliente, occupée sur l’agenda."
        error={errors.bufferAfterMinutes?.message}
        {...register('bufferAfterMinutes')}
      />

      <p className="spa-admin-toolbar__hint">
        Durée bloquée sur l’agenda : <strong>{formatDuration(occupied)}</strong> — durée du soin et
        tampons compris.
      </p>

      <Field
        id="service-price"
        label={`Prix (${currency})`}
        required
        inputMode="decimal"
        placeholder="35,00"
        hint="Devise de l’établissement. Un soin offert vaut 0."
        error={errors.price?.message}
        {...register('price')}
      />

      <Field
        id="service-slug"
        label="Adresse publique"
        hint={
          service === undefined
            ? 'Laissez vide : elle sera dérivée du nom. Utile à renseigner pour figer un lien déjà partagé.'
            : 'Le lien profond vers cette prestation. La changer casse les liens déjà partagés.'
        }
        error={errors.slug?.message}
        {...register('slug')}
      />

      <Button
        type="submit"
        variant="accent"
        block
        loading={isSubmitting}
        loadingLabel="Enregistrement…"
      >
        {service === undefined ? 'Créer la prestation' : 'Enregistrer'}
      </Button>
    </form>
  );
}
