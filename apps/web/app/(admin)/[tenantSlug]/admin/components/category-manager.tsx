'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  displayNameSchema,
  longTextSchema,
  slugSchema,
  type ServiceCategory,
} from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { TextArea } from '@/components/ui/textarea';

import { createServiceCategoryAction, updateServiceCategoryAction } from '../catalogue/actions';
import { CatalogStatusBadge } from './catalog-status-badge';

/**
 * Rubriques du catalogue — création, renommage, activation (#52, deuxième critère).
 *
 * ## Une rubrique se désactive, elle ne se supprime pas
 *
 * Des prestations la référencent, et la clé étrangère `Restrict` de
 * `services.category_id` refuserait l'effacement. Surtout : le reporting doit
 * continuer à savoir sous quelle rubrique une vente a été faite. L'API n'expose
 * donc aucun `DELETE`, et cet écran n'en propose pas.
 *
 * ## Pourquoi les rubriques désactivées restent affichées
 *
 * C'est ici qu'on vient les rechercher pour les remettre en ligne. Les masquer
 * ferait croire qu'elles ont disparu et inviterait à en recréer une du même nom
 * — pour se heurter au conflit d'unicité du slug.
 */

const categoryFormSchema = z.object({
  name: displayNameSchema,
  slug: z.union([z.literal(''), slugSchema]),
  description: longTextSchema,
});

type CategoryFormValues = z.input<typeof categoryFormSchema>;

/**
 * Le formulaire d'une rubrique — le même pour la créer et pour la modifier.
 *
 * Les deux gestes portent les mêmes champs et les mêmes règles ; les tenir en
 * deux composants garantirait qu'une validation ajoutée à l'un manque à l'autre.
 */
function CategoryForm({
  tenantSlug,
  category,
  onDone,
}: {
  readonly tenantSlug: string;
  readonly category?: ServiceCategory;
  /** Appelé après un enregistrement réussi — referme l'édition en ligne. */
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  const suffix = category?.id ?? 'nouvelle';

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CategoryFormValues, unknown, z.output<typeof categoryFormSchema>>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: {
      name: category?.name ?? '',
      slug: category?.slug ?? '',
      description: category?.description ?? '',
    },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);

    const result =
      category === undefined
        ? await createServiceCategoryAction(tenantSlug, {
            name: values.name,
            ...(values.slug === '' ? {} : { slug: values.slug }),
            ...(values.description === '' ? {} : { description: values.description }),
          })
        : await updateServiceCategoryAction(tenantSlug, category.id, {
            name: values.name,
            slug: values.slug === '' ? category.slug : values.slug,
            // `null` efface le texte ; la chaîne vide descendrait jusqu'à la
            // colonne comme une description d'un caractère nul.
            description: values.description === '' ? null : values.description,
          });

    if (!result.ok) {
      if (result.code === ERROR_CODES.CONFLICT) {
        setError('slug', { message: 'une autre rubrique porte déjà cette adresse.' });
        return;
      }
      setFailure(result.message);
      return;
    }

    if (category === undefined) {
      reset({ name: '', slug: '', description: '' });
    }
    onDone();
    router.refresh();
  });

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      {failure === null ? null : (
        <Notification tone="danger" title="L’enregistrement a échoué">
          <p>{failure}</p>
        </Notification>
      )}

      <Field
        id={`category-name-${suffix}`}
        label="Nom de la rubrique"
        required
        placeholder="Soins du visage"
        error={errors.name?.message}
        {...register('name')}
      />
      <TextArea
        id={`category-description-${suffix}`}
        label="Description"
        hint="Facultative."
        error={errors.description?.message}
        {...register('description')}
      />
      <Field
        id={`category-slug-${suffix}`}
        label="Adresse publique"
        hint={
          category === undefined
            ? 'Laissez vide : elle sera dérivée du nom.'
            : 'La changer casse les liens déjà partagés vers cette rubrique.'
        }
        error={errors.slug?.message}
        {...register('slug')}
      />

      <Button
        type="submit"
        variant="accent"
        loading={isSubmitting}
        loadingLabel="Enregistrement…"
      >
        {category === undefined ? 'Créer la rubrique' : 'Enregistrer'}
      </Button>
    </form>
  );
}

/**
 * Bascule l'activité d'une rubrique — même régime que celle d'une prestation,
 * `useTransition` compris : `router.refresh()` ne remonte pas ce composant, et un
 * drapeau posé avant l'appel sans être rendu laisserait le bouton désactivé pour
 * toujours.
 */
function CategoryActivationButton({
  tenantSlug,
  category,
}: {
  readonly tenantSlug: string;
  readonly category: ServiceCategory;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    setSaving(true);
    setFailure(null);

    const result = await updateServiceCategoryAction(tenantSlug, category.id, {
      isActive: !category.isActive,
    });

    if (!result.ok) {
      setFailure(result.message);
      setSaving(false);
      return;
    }

    startRefresh(() => {
      router.refresh();
    });
    setSaving(false);
  }

  return (
    <>
      <Button
        variant={category.isActive ? 'quiet' : 'neutral'}
        loading={saving || refreshing}
        loadingLabel="Mise à jour…"
        onClick={() => void toggle()}
      >
        {category.isActive ? 'Désactiver' : 'Réactiver'}
        <span className="spa-visually-hidden"> {category.name}</span>
      </Button>
      {failure === null ? null : (
        <p className="spa-field__error" role="alert">
          {failure}
        </p>
      )}
    </>
  );
}

export function CategoryManager({
  tenantSlug,
  categories,
}: {
  readonly tenantSlug: string;
  readonly categories: readonly ServiceCategory[];
}) {
  // Une seule rubrique s'édite à la fois : deux formulaires ouverts sur la même
  // liste inviteraient à en enregistrer un et à perdre l'autre sans le voir.
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="spa-admin__content">
      <section className="spa-admin__section" aria-labelledby="rubrique-nouvelle">
        <h2 className="spa-admin__section-title" id="rubrique-nouvelle">
          Nouvelle rubrique
        </h2>
        <CategoryForm tenantSlug={tenantSlug} onDone={() => setEditing(null)} />
      </section>

      <section className="spa-admin__section" aria-labelledby="rubriques-existantes">
        <h2 className="spa-admin__section-title" id="rubriques-existantes">
          Rubriques du catalogue
        </h2>

        {categories.length === 0 ? (
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">Aucune rubrique</p>
            <p className="spa-empty-state__description">
              Les prestations restent affichées sans regroupement tant qu’aucune rubrique n’existe.
              Ce n’est pas une erreur — c’est le cas d’un salon qui vend une poignée de soins.
            </p>
          </div>
        ) : (
          <table className="spa-admin-table">
            <caption className="spa-visually-hidden">
              Rubriques du catalogue, actives et désactivées.
            </caption>
            <thead>
              <tr>
                <th className="spa-admin-table__head" scope="col">
                  Rubrique
                </th>
                <th className="spa-admin-table__head" scope="col">
                  Adresse publique
                </th>
                <th className="spa-admin-table__head" scope="col">
                  État
                </th>
                <th className="spa-admin-table__head" scope="col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <tr className="spa-admin-table__row" key={category.id}>
                  <td className="spa-admin-table__cell">
                    {category.name}
                    {editing === category.id ? (
                      <CategoryForm
                        tenantSlug={tenantSlug}
                        category={category}
                        onDone={() => setEditing(null)}
                      />
                    ) : null}
                  </td>
                  <td className="spa-admin-table__cell">{category.slug}</td>
                  <td className="spa-admin-table__cell">
                    <CatalogStatusBadge isActive={category.isActive} />
                  </td>
                  <td className="spa-admin-table__cell">
                    <Button
                      variant="quiet"
                      aria-expanded={editing === category.id}
                      onClick={() => setEditing(editing === category.id ? null : category.id)}
                    >
                      {editing === category.id ? 'Fermer' : 'Modifier'}
                      <span className="spa-visually-hidden"> {category.name}</span>
                    </Button>
                    <CategoryActivationButton tenantSlug={tenantSlug} category={category} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
