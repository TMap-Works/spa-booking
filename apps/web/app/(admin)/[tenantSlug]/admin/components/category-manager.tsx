'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  displayNameSchema,
  longTextSchema,
  slugSchema,
  type ServiceCategory,
} from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { TextArea } from '@/components/ui/textarea';

import { createServiceCategoryAction, updateServiceCategoryAction } from '../catalogue/actions';
import { adminServiceCategoryPath } from '../catalogue/paths';
import { CatalogStatusBadge } from './catalog-status-badge';
import { useAdminSessionRenewal } from './use-admin-session-renewal';

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
 *
 * ## Ce que le rang praticien voit
 *
 * La liste, et rien d'autre : `POST` et `PATCH /v1/service-categories` sont
 * `@AuthAtLeast('MANAGER')`. Le formulaire de création et la colonne « Actions »
 * disparaissent donc pour ce rôle — comme la colonne « Actions » de la liste du
 * personnel — et une mention dit pourquoi (#619). Ce filtrage ne protège rien :
 * la seule garde qui compte est celle de l'API.
 *
 * Le **nom** reste un lien pour tous les rangs, comme celui d'une prestation :
 * `GET /v1/service-categories` se lit dès le rang praticien, et l'écran d'une
 * rubrique rend ses champs inertes plutôt que de disparaître — une praticienne a
 * besoin de lire la description et l'adresse publique de ce sous quoi elle
 * travaille.
 *
 * ## L'édition a quitté la cellule du tableau (#769)
 *
 * Elle s'y dépliait derrière un bouton « Modifier », dans la première cellule de
 * la ligne : la ligne passait à quelque 370 px de haut, le nom de la rubrique
 * s'affichait deux fois — dans la cellule et dans le champ —, les trois autres
 * cellules restaient centrées à mi-hauteur loin du formulaire, et « Enregistrer »
 * entrait en concurrence avec « Créer la rubrique » sans rien qui les distingue.
 * Deux boutons accentués pleine largeur, pour deux gestes différents.
 *
 * La prestation, elle, s'édite depuis toujours sur sa propre page. L'audit de
 * conception `d20260916-1` a relevé l'écart (`ds:coherence`) : deux listes du
 * même module ouvraient le même type d'objet de deux gestes différents. Le nom
 * mène donc à `rubriques/{id}`, la colonne « Actions » ne porte plus que la
 * bascule d'activité, et le tableau retrouve son rôle de tableau.
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
 *
 * ## Le `<form>` est la carte, il n'est pas dedans (#633)
 *
 * Il portait auparavant un `<form>` nu, rangé dans une `<section>` qui était, elle,
 * la carte `.spa-admin__section`. Cette classe est ce qui donne à ses enfants leur
 * rythme vertical — `display: flex` en colonne, `gap: var(--spa-space-3)` —, et le
 * `<form>` intercalé la privait d'effet : les groupes de champs redevenaient des
 * blocs du flux normal, empilés à **0 px**. « Description » se collait au bas de
 * « Nom de la rubrique », « Adresse publique » à la mention « Facultative. », et le
 * bouton au dernier texte d'aide.
 *
 * `ServiceForm`, sur `/catalogue/nouveau`, ne s'est jamais posé la question : son
 * `<form>` **est** la carte. C'est ce balisage-là qui est repris ici — la gouttière
 * de 12 px de l'écran voisin vient de là, et non d'une règle ajoutée pour ce
 * ticket. Le titre de la section descend donc dans le formulaire, faute de quoi il
 * resterait hors de la carte qu'il nomme.
 *
 * L'écran d'une rubrique le rend tel quel, sans conteneur autour : le `<form>`
 * porte déjà sa carte et sa borne de colonne, et une seconde enveloppe ne
 * mesurerait rien de plus.
 *
 * ## Le bouton primaire occupe sa carte (#634)
 *
 * `block` manquait ici seul : « Créer la rubrique » se rendait en largeur
 * automatique — 164 px relevés par la campagne contre les 966 px de « Créer la
 * prestation » sur l'écran voisin, à 1280 px. Un même rôle, deux rendus, à un
 * clic de distance.
 *
 * La forme dominante du back-office est la pleine largeur : `ServiceForm`,
 * `TenantSettingsForm`, `AdminLoginForm`, `ClientSearchForm`, `ClientPicker` et
 * l'encaissement passent tous `block` sur leur bouton de soumission. C'est donc
 * ce formulaire-ci qui rejoint les autres, et non l'inverse — aucune règle CSS
 * ajoutée, aucun composant partagé modifié.
 *
 * `block` est posé sans condition, comme dans `ServiceForm` : création et
 * édition partagent le même formulaire, et n'en habiller qu'une moitié
 * réintroduirait à l'intérieur d'un composant l'incohérence qu'on vient de
 * retirer entre deux écrans.
 *
 * `spa-admin-form` vient avec lui, et sans lui la correction serait fausse. Un
 * bouton en pleine largeur mesure sa carte : `/catalogue/nouveau` borne la
 * sienne à 44 rem (#630), `/catalogue/rubriques` ne l'était pas — la campagne de
 * #630 n'y avait relevé aucun champ étiré, et l'écran était resté hors de sa
 * liste. `block` seul y rendait donc un bouton de toute la zone de contenu :
 * **926 px** mesurés à 1280 px de fenêtre, contre 670 px sur l'écran voisin. Le
 * même écart, dans l'autre sens.
 *
 * Avec les deux, les deux boutons mesurent **670 px** dans une carte de 704 px —
 * mesure faite au navigateur, phase de recette. La borne se pose sur le `<form>`
 * lui-même, comme `StaffInviteForm` la pose sur sa `<section>` ; la liste des
 * rubriques, elle, garde ses 926 px, parce qu'un tableau profite de la place
 * qu'un formulaire gaspille.
 */
export function CategoryForm({
  tenantSlug,
  category,
  canManage = true,
}: {
  readonly tenantSlug: string;
  /** Absente, le formulaire crée ; présente, il modifie. */
  readonly category?: ServiceCategory;
  /**
   * `false` au rang praticien : `POST` et `PATCH /v1/service-categories` sont
   * `@AuthAtLeast('MANAGER')`. Les champs restent lisibles et deviennent
   * inertes, et le bouton cède la place à la raison — le geste de `ServiceForm`
   * sur la fiche d'une prestation (#619).
   */
  readonly canManage?: boolean;
}) {
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [saved, setSaved] = useState(false);
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

  const submit = handleSubmit(
    async (values) => {
      setFailure(null);
      setSaved(false);

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
        if (renewIfExpired(result)) {
          return;
        }
        if (result.code === ERROR_CODES.CONFLICT) {
          setError('slug', { message: 'une autre rubrique porte déjà cette adresse.' });
          return;
        }
        setFailure(result.message);
        return;
      }

      if (category === undefined) {
        reset({ name: '', slug: '', description: '' });
      } else {
        setSaved(true);
      }

      // Les deux écrans sont rendus côté serveur : sans ce rafraîchissement, la
      // liste garderait le nom d'avant l'enregistrement et l'écran de la rubrique
      // réafficherait les valeurs qu'on vient de remplacer.
      router.refresh();
    },
    () => {
      /*
       * Une saisie refusée par le schéma n'atteint jamais le rappel ci-dessus :
       * sans ce second rappel, le bandeau « Rubrique enregistrée » du précédent
       * enregistrement resterait à l'écran **au-dessus** de l'erreur du champ,
       * et annoncerait comme enregistré un nom vide qui ne l'est pas.
       */
      setSaved(false);
      setFailure(null);
    },
  );

  return (
    <form
      className="spa-admin__section spa-admin-form"
      aria-labelledby={category === undefined ? 'rubrique-nouvelle' : undefined}
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      {category === undefined ? (
        <h2 className="spa-admin__section-title" id="rubrique-nouvelle">
          Nouvelle rubrique
        </h2>
      ) : null}

      {saved ? (
        <Notification tone="success" title="Rubrique enregistrée">
          <p>La page publique du salon reflète désormais ces informations.</p>
        </Notification>
      ) : null}

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
        disabled={!canManage}
        error={errors.name?.message}
        {...register('name')}
      />
      <TextArea
        id={`category-description-${suffix}`}
        label="Description"
        hint="Facultative."
        disabled={!canManage}
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
        disabled={!canManage}
        error={errors.slug?.message}
        {...register('slug')}
      />

      {canManage ? (
        <Button
          type="submit"
          variant="accent"
          block
          loading={isSubmitting}
          loadingLabel="Enregistrement…"
        >
          {category === undefined ? 'Créer la rubrique' : 'Enregistrer'}
        </Button>
      ) : (
        <p className="spa-admin-toolbar__hint">
          La modification des rubriques est réservée au rang gérant.
        </p>
      )}
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
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
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
      if (renewIfExpired(result)) {
        setSaving(false);
        return;
      }
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
  canManage = true,
}: {
  readonly tenantSlug: string;
  readonly categories: readonly ServiceCategory[];
  /**
   * `false` au rang praticien : la création et la bascule d'activité sont
   * toutes deux `@AuthAtLeast('MANAGER')`. La liste reste lisible, ses commandes
   * disparaissent — le nom, lui, reste un lien : l'écran d'une rubrique se lit à
   * ce rang, et il dit lui-même ce qu'il ne permet pas d'y changer.
   */
  readonly canManage?: boolean;
}) {
  return (
    <div className="spa-admin__content">
      {canManage ? (
        // Pas d'enveloppe : le `<form>` est lui-même la carte `.spa-admin__section`
        // et porte le titre de la section (#633). Une `<section>` de plus autour de
        // lui remettrait une carte dans une carte — et surtout, la gouttière de
        // cette enveloppe n'écarterait que le titre et le `<form>` qu'elle
        // contiendrait, jamais les champs, qui sont ce qu'il fallait écarter.
        <CategoryForm tenantSlug={tenantSlug} />
      ) : (
        <p className="spa-admin-toolbar__hint">
          La création et la modification des rubriques sont réservées au rang gérant.
        </p>
      )}

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
                {canManage ? (
                  <th className="spa-admin-table__head" scope="col">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <tr className="spa-admin-table__row" key={category.id}>
                  <td className="spa-admin-table__cell">
                    {/* Le geste de la liste des prestations : le nom ouvre
                        l'objet. Il l'ouvre pour tous les rangs — l'écran est
                        lisible au rang praticien, et inerte (#769). */}
                    <Link href={adminServiceCategoryPath(tenantSlug, category.id)}>
                      {category.name}
                    </Link>
                  </td>
                  <td className="spa-admin-table__cell">{category.slug}</td>
                  <td className="spa-admin-table__cell">
                    <CatalogStatusBadge isActive={category.isActive} />
                  </td>
                  {canManage ? (
                    <td className="spa-admin-table__cell">
                      <CategoryActivationButton tenantSlug={tenantSlug} category={category} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
