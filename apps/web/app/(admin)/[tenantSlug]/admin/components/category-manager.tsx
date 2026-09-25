'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  DISPLAY_NAME_MAX_LENGTH,
  ERROR_CODES,
  SLUG_MAX_LENGTH,
  longTextSchema,
  resourceSlugSchema,
  slugSchema,
  zodErrorMap,
  type Locale,
  type ServiceCategory,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
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

/**
 * Les phrases que ce formulaire écrit lui-même, dans la langue de l'écran (#849).
 *
 * Elles existent pour la raison exposée dans `service-form.tsx` : `zodErrorMap`
 * ne traduit **pas** les messages qu'un schéma du contrat écrit lui-même
 * (`zod-messages.ts` le dit, et c'est voulu), si bien que « ce champ est
 * obligatoire » et « slug attendu en minuscules… » s'affichaient en français
 * sous un formulaire anglais. La règle reste celle du contrat — les bornes du
 * nom sont les siennes, l'adresse est validée par `slugSchema` lui-même ; seule
 * la phrase vient de l'écran.
 */
interface CategoryFormMessages {
  readonly nameRequired: string;
  readonly nameTooLong: string;
  readonly slug: string;
  readonly slugReserved: string;
  readonly slugTooLong: string;
}

/**
 * Pourquoi `slugSchema` a refusé cette adresse — même écriture, et même raison,
 * que `slugRefusal` de `service-form.tsx` : une phrase unique dirait « minuscules,
 * chiffres et tirets simples » d'un `tarifs` qui n'a que des minuscules, et la
 * gérante n'aurait aucun moyen d'apprendre que c'est un nom réservé.
 */
function slugRefusal(
  value: string,
  messages: Pick<CategoryFormMessages, 'slug' | 'slugReserved' | 'slugTooLong'>,
): string | null {
  const parsed = slugSchema.safeParse(value);

  if (parsed.success) {
    return null;
  }

  if (parsed.error.issues.some((issue) => issue.code === 'too_big')) {
    return messages.slugTooLong;
  }

  /*
   * Le nom réservé se distingue de la faute de forme en rejouant **la seule
   * règle qui les sépare** : `slugSchema` est `resourceSlugSchema` plus la liste
   * des noms que la plateforme garde. Une adresse que le second accepte et que
   * le premier refuse est donc réservée, et pas autre chose.
   *
   * Lu ainsi plutôt que sur le code de l'`issue` depuis #1232 : les deux règles
   * du contrat sont maintenant des `refine` — c'est ce qui leur permet de porter
   * une clé de message traduisible —, et elles rendent donc toutes les deux un
   * `custom`. Le code ne les distinguait plus, et `www` se serait vu reprocher
   * une minuscule qu'il a déjà.
   */
  return resourceSlugSchema.safeParse(value).success ? messages.slugReserved : messages.slug;
}

function categoryFormSchema(messages: CategoryFormMessages) {
  return z.object({
    name: z
      .string()
      .trim()
      .min(1, { message: messages.nameRequired })
      .max(DISPLAY_NAME_MAX_LENGTH, { message: messages.nameTooLong }),
    // Même branchement que `service-form.tsx` : vide vaut « dérive-la du nom »,
    // sinon c'est `slugSchema` qui tranche.
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .superRefine((value, ctx) => {
        const refusal = value === '' ? null : slugRefusal(value, messages);

        if (refusal !== null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: refusal });
        }
      }),
    description: longTextSchema,
  });
}

type CategoryFormSchema = ReturnType<typeof categoryFormSchema>;
type CategoryFormValues = z.input<CategoryFormSchema>;

/**
 * Ce que le dernier enregistrement a produit — et non plus un simple « c'est
 * fait » (#998).
 *
 * La création porte la rubrique obtenue, parce que le bandeau la **nomme** et
 * ouvre son écran : le formulaire vient d'être vidé, et « Rubrique enregistrée »
 * seul laisserait chercher laquelle dans un tableau qui passe sous le pli dès la
 * dixième ligne.
 */
type CategoryOutcome =
  | { readonly kind: 'created'; readonly category: ServiceCategory }
  | { readonly kind: 'updated' };

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
 *
 * ## La création se confirme, comme l'enregistrement (#998)
 *
 * Elle ne le faisait pas : le formulaire se vidait, et le seul indice était une
 * ligne de plus dans le tableau du dessous — sous le pli dès qu'une dizaine de
 * rubriques existent. Le même composant annonçait pourtant « Rubrique
 * enregistrée » quand on enregistrait une rubrique **existante**. Deux issues du
 * même geste, deux traitements, dans un fichier de deux cents lignes : l'audit
 * de conception `d20260917-2` l'a relevé au titre de `ds:etats` — « un succès
 * qui ne se voit pas n'existe pas pour celle qui vient d'agir »
 * (`.claude/skills/web-frontend/SKILL.md` §6).
 *
 * Le bandeau de création **nomme la rubrique** et ouvre son écran. Les deux
 * tiennent au même fait : le formulaire est vide juste après, et un « c'est
 * fait » anonyme laisserait retrouver soi-même, dans la liste, ce qu'on vient de
 * créer. Le lien est le geste suivant que l'audit demandait — c'est là que se
 * corrige un slug dérivé qu'on ne voulait pas.
 *
 * ## Pourquoi une région montée en permanence
 *
 * Une région `aria-live` insérée **avec** son message n'est annoncée par aucun
 * lecteur d'écran de façon fiable : l'annonce se déclenche sur la mutation d'une
 * région déjà suivie. Rendre le `<Notification>` au retour de l'action — ce qui
 * suffit visuellement — resterait donc muet, et l'audit demande une région
 * *annoncée* (WCAG 2.2 AA, 4.1.3 « Messages d'état »).
 *
 * D'où le conteneur toujours monté, `spa-visually-hidden` tant qu'il n'y a rien
 * à dire : la classe sort l'élément du flux (`base.css`), si bien qu'une région
 * vide ne consomme pas la gouttière de `.spa-admin__section` — c'est la classe
 * qui change, jamais le nœud, et React ne le remplace donc pas. C'est le geste
 * déjà écrit pour l'espace client (`account-announcement.tsx`), repris sans rien
 * lui ajouter.
 *
 * Deux détails s'y rattachent :
 *
 * - `aria-atomic="true"` — le titre lu seul perdrait le nom de la rubrique ;
 * - le `role="status"` du `<Notification>` fait double emploi avec la région qui
 *   le porte, mais il vient du design system et ne se modifie pas d'ici. Deux
 *   régions imbriquées annoncent **une** fois, là où un bandeau posé à côté d'une
 *   annonce invisible ferait lire la phrase deux fois.
 *
 * L'échec, lui, reste hors de la région : son `role="alert"` est *assertif* par
 * nature — il interrompt — et l'enfermer dans une région polie reviendrait à le
 * faire attendre une pause.
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
  const t = useTranslations('admin-catalog.categoryForm');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [outcome, setOutcome] = useState<CategoryOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const suffix = category?.id ?? 'nouvelle';
  /*
   * Deux sources de refus, et les deux sont dans la langue de l'écran (#849) :
   * les phrases de la fabrique ci-dessus, et celles que **zod** écrit pour les
   * bornes du contrat — la description trop longue —, par `zodErrorMap`.
   *
   * `path` et `async` ne sont là que pour le **typage** de
   * `@hookform/resolvers`, qui déclare `ParseParams` entier là où zod n'en lit
   * qu'une partie : au runtime, `safeParseAsync` force `async: true` et retombe
   * sur `path: []`.
   */
  const resolver = useMemo(
    () =>
      zodResolver(
        categoryFormSchema({
          nameRequired: t('errors.nameRequired'),
          nameTooLong: t('errors.nameTooLong', { max: DISPLAY_NAME_MAX_LENGTH }),
          slug: t('errors.slug'),
          slugReserved: t('errors.slugReserved'),
          slugTooLong: t('errors.slugTooLong', { max: SLUG_MAX_LENGTH }),
        }),
        { errorMap: zodErrorMap(locale), path: [], async: true },
      ),
    [locale, t],
  );

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CategoryFormValues, unknown, z.output<CategoryFormSchema>>({
    resolver,
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
      setOutcome(null);

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
          setError('slug', { message: t('slugTaken') });
          return;
        }
        setFailure(result.message);
        return;
      }

      if (category === undefined) {
        reset({ name: '', slug: '', description: '' });
        setOutcome({ kind: 'created', category: result.data });
      } else {
        setOutcome({ kind: 'updated' });
      }

      // Les deux écrans sont rendus côté serveur : sans ce rafraîchissement, la
      // liste garderait le nom d'avant l'enregistrement et l'écran de la rubrique
      // réafficherait les valeurs qu'on vient de remplacer.
      router.refresh();
    },
    () => {
      /*
       * Une saisie refusée par le schéma n'atteint jamais le rappel ci-dessus :
       * sans ce second rappel, le bandeau du précédent enregistrement resterait
       * à l'écran **au-dessus** de l'erreur du champ, et annoncerait comme
       * enregistré un nom vide qui ne l'est pas.
       */
      setOutcome(null);
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
          {t('newTitle')}
        </h2>
      ) : null}

      {/* Montée du premier rendu, vide et hors du flux tant qu'il n'y a rien à
          dire : une région `aria-live` insérée avec son message n'est annoncée
          par aucun lecteur d'écran de façon fiable (#998). */}
      <div
        className={outcome === null ? 'spa-visually-hidden' : undefined}
        aria-live="polite"
        aria-atomic="true"
      >
        {outcome === null ? null : outcome.kind === 'created' ? (
          // Le nom de la rubrique est la saisie du salon : il est **inséré** dans
          // la phrase traduite, jamais traduit lui-même.
          <Notification tone="success" title={t('createdTitle', { name: outcome.category.name })}>
            {/* Au futur, et c'est voulu : la liste est rendue côté serveur et ne
                rattrape son retard qu'au retour de `router.refresh()`. « Elle
                figure dans la liste ci-dessous » contredirait, le temps d'un
                aller-retour, l'état vide « Aucune rubrique » encore affiché sous
                le bandeau — et une rubrique neuve ne paraît de toute façon en
                public qu'une fois une prestation classée dessous. */}
            {/* `t.rich` et non une phrase coupée en deux clés : le lien est au
                milieu du texte en français comme en anglais, et une découpe
                figerait l'ordre des morceaux. */}
            <p>
              {t.rich('createdBody', {
                link: (parts) => (
                  <Link href={adminServiceCategoryPath(tenantSlug, outcome.category.id)}>
                    {parts}
                  </Link>
                ),
              })}
            </p>
          </Notification>
        ) : (
          <Notification tone="success" title={t('savedTitle')}>
            <p>{t('savedBody')}</p>
          </Notification>
        )}
      </div>

      {failure === null ? null : (
        <Notification tone="danger" title={t('failureTitle')}>
          <p>{failure}</p>
        </Notification>
      )}

      <Field
        id={`category-name-${suffix}`}
        label={t('name')}
        required
        placeholder={t('namePlaceholder')}
        disabled={!canManage}
        error={errors.name?.message}
        {...register('name')}
      />
      <TextArea
        id={`category-description-${suffix}`}
        label={t('description')}
        hint={t('descriptionHint')}
        disabled={!canManage}
        error={errors.description?.message}
        {...register('description')}
      />
      <Field
        id={`category-slug-${suffix}`}
        label={t('slug')}
        hint={category === undefined ? t('slugHintNew') : t('slugHintEdit')}
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
          loadingLabel={t('saving')}
        >
          {category === undefined ? t('create') : t('save')}
        </Button>
      ) : (
        <p className="spa-admin-toolbar__hint">{t('restricted')}</p>
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
  const t = useTranslations('admin-catalog.activation');
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
        loadingLabel={t('updating')}
        onClick={() => void toggle()}
      >
        {category.isActive ? t('deactivate') : t('reactivate')}
        {/* Le nom de la rubrique n'est pas traduit : c'est lui qui distingue les
            boutons « Désactiver » d'un tableau pour un lecteur d'écran. */}
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
  const t = useTranslations('admin-catalog.categoryManager');

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
        <p className="spa-admin-toolbar__hint">{t('restricted')}</p>
      )}

      <section className="spa-admin__section" aria-labelledby="rubriques-existantes">
        <h2 className="spa-admin__section-title" id="rubriques-existantes">
          {t('title')}
        </h2>

        {categories.length === 0 ? (
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">{t('emptyTitle')}</p>
            <p className="spa-empty-state__description">{t('emptyDescription')}</p>
          </div>
        ) : (
          <table className="spa-admin-table">
            <caption className="spa-visually-hidden">{t('caption')}</caption>
            <thead>
              <tr>
                <th className="spa-admin-table__head" scope="col">
                  {t('columns.category')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('columns.slug')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('columns.state')}
                </th>
                {canManage ? (
                  <th className="spa-admin-table__head" scope="col">
                    {t('columns.actions')}
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
