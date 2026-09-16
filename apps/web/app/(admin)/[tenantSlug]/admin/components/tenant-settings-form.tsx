'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ADDRESS_LINE_MAX_LENGTH,
  CITY_MAX_LENGTH,
  POSTAL_CODE_MAX_LENGTH,
  displayNameSchema,
  emailSchema,
  openingHoursSchema,
  phoneSchema,
  postalAddressSchema,
  type OpeningHoursEntry,
  type Tenant,
  type UpdateTenantRequest,
} from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { weekdayLabel } from '@/components/salon/opening-hours';

import { updateTenantSettingsAction } from '../actions';

/**
 * Réglages de l'établissement — adresse, horaires d'ouverture, coordonnées
 * (#343, quatrième critère).
 *
 * ## Le formulaire est complet, la requête est partielle
 *
 * `updateTenantRequestSchema` est `.partial()` : l'API accepte qu'on n'envoie
 * qu'un champ. L'écran, lui, affiche tout pré-rempli — c'est ce qu'on attend
 * d'un « réglages de l'établissement », et cela évite de faire deviner ce qui
 * est modifiable. La conversion se fait à l'envoi : un champ vidé devient
 * `null` — la valeur par laquelle on **efface** — et non la chaîne vide, que la
 * colonne prendrait pour une valeur d'un caractère nul.
 *
 * ## Deux plages par jour, et ce qui arrive aux autres
 *
 * Une journée à coupure méridienne porte deux plages : « 09:00–12:00 » et
 * « 14:00–19:00 ». La grille en propose donc deux par jour, ce qui couvre le cas
 * réel sans faire de cet écran un éditeur d'agenda.
 *
 * Le contrat, lui, en accepte davantage. Une semaine posée autrement — import,
 * correctif de données — pourrait donc porter une troisième plage un jour donné.
 * Comme l'enregistrement **remplace la semaine entière**, l'afficher tronquée la
 * détruirait au premier « Enregistrer ». Ces plages surnuméraires sont donc
 * conservées telles quelles et renvoyées avec les autres : l'écran n'édite que
 * ce qu'il montre, et ne détruit rien de ce qu'il ne montre pas.
 *
 * ## Fermé est un état, pas quatre champs vides (#764)
 *
 * La grille présentait la journée de fermeture comme la journée non renseignée :
 * quatre champs vides, dont les placeholders gris annonçaient « 09:00 / 12:00 ».
 * Sur Spa Lumière, fermé le week-end, le samedi et le dimanche se lisaient donc
 * comme un salon ouvert le matin — et rien nulle part ne disait le contraire.
 * C'est exactement ce que `styles/admin/README.md` §3.4 refuse : « Fermé est un
 * état, pas une plage vide (`__closed`) : sans quoi “pas encore saisi” et “le
 * salon ferme le mercredi” se confondent. »
 *
 * Le motif repris est celui de la semaine d'un praticien
 * (`personnel/components/staff-schedule-editor.tsx`), au balisage près — même
 * interrupteur `__toggle`, même `__closed`, mêmes mots : un back-office qui
 * nomme deux fois la même chose de deux façons fait douter de laquelle est la
 * bonne. Décocher « Ouvert » **retire** les plages du jour plutôt que de les
 * masquer : une borne restée seule ferait sinon échouer la validation sur un
 * champ que l'écran n'affiche plus, et la journée « fermée » repartirait avec
 * ses heures au premier « Enregistrer ». Recocher en propose une, comme là-bas.
 *
 * L'interrupteur ne vaut que par ce qu'il empêche : une journée cochée « Ouvert »
 * dont on a vidé les deux plages est refusée, faute de quoi elle s'enregistrerait
 * fermée — l'ambiguïté déplacée d'un cran plutôt que levée.
 *
 * ## Le fuseau est nommé, et il est nommé sous les champs
 *
 * « Heures de votre horloge » désignait l'horloge du navigateur, c'est-à-dire
 * celle de qui regarde l'écran — un gérant en déplacement aurait saisi la
 * semaine du salon dans son fuseau à lui. Le README §3 tranche : toutes les
 * heures affichées sont dans **le fuseau du salon**, « écrit en clair dans le
 * pied de la barre latérale et sous les champs d'horaire ». La mention est donc
 * posée sous la grille, dans les termes de la fiche praticien, et elle nomme le
 * fuseau de l'établissement — `tenant.timezone`, soit « Europe/Paris » pour un
 * salon parisien — au lieu de renvoyer à une horloge dont on ne sait pas
 * laquelle c'est. Le contrat le porte déjà et il n'est pas optionnel
 * (`publicTenantSchema`) : il n'y a rien à ajouter à `packages/shared`.
 *
 * ## Le nom accessible d'un champ d'horaire porte son jour
 *
 * La grille aligne 28 champs, et le libellé visible n'en distingue que quatre :
 * « Ouverture 1 », « Fermeture 1 », « Ouverture 2 », « Fermeture 2 ». Le jour
 * n'est lisible que dans la colonne d'à côté — c'est-à-dire à l'œil, et
 * seulement à l'œil. Au clavier ou au lecteur d'écran, l'ouverture du lundi et
 * celle du dimanche s'annonçaient donc à l'identique, sur les heures mêmes qui
 * pilotent ce que la page publique affiche (#621).
 *
 * Chaque champ porte donc un `aria-label` qui nomme son jour — « Ouverture 1 du
 * lundi » —, dans les mêmes termes que la semaine d'un praticien
 * (`staff-schedule-editor.tsx` : « Début de la plage du lundi »). Là-bas le nom
 * tient dans un `<label>` visuellement masqué, faute de libellé visible ; ici il
 * en existe un, et c'est l'`aria-label` qui l'étend sans le répéter sept fois à
 * l'écran. Le libellé visible **ouvre** le nom accessible, et ne s'y trouve pas
 * seulement contenu : c'est ce que demande WCAG 2.5.3, sans quoi la commande
 * vocale « Ouverture 1 » ne désignerait plus rien.
 *
 * Le libellé visible, lui, ne change pas : répéter le jour sept fois dans la
 * colonne alourdirait une grille dont la lecture verticale est justement ce qui
 * fait repérer le mercredi resté vide. Le jour est rattaché aux champs par un
 * `role="group"` renvoyant au libellé de la ligne, ce qui donne au groupe le nom
 * que le `<fieldset>` lui donnerait sans exposer la grille CSS aux réglages par
 * défaut de cet élément.
 *
 * Le nom du jour vient de `weekdayLabel` (`components/salon/opening-hours.ts`),
 * celui-là même dont la vitrine publique se sert : un seul point d'écriture pour
 * la formulation et pour son repli, faute de quoi deux copies d'une branche que
 * rien n'exerce finissent par diverger — et la divergence se lirait ici dans ce
 * qu'un lecteur d'écran annonce (#652).
 *
 * ## Le verdict se rend contre le bouton, pas en tête d'écran
 *
 * L'écran mesure environ 2 500 px : le nom, l'adresse, les 28 champs de la
 * grille horaire, les coordonnées, puis « Enregistrer ». Tant que le verdict
 * était peint en tête de section, il apparaissait à quelque 2 400 px au-dessus
 * du bouton qu'on venait de cliquer, pour une fenêtre de 900 px — l'écran restait
 * strictement identique après un enregistrement réussi, et rien ne disait que
 * quoi que ce soit avait été sauvegardé (#635).
 *
 * Il est donc rendu en dernier enfant du `<form>`, juste au-dessus du bouton :
 * le geste et sa réponse tiennent dans le même champ de vision, quel que soit
 * l'endroit où la page a été laissée. Placé **avant** le bouton plutôt qu'après,
 * il suit l'ordre de lecture — au clavier, la tabulation qui repart du bouton ne
 * saute pas par-dessus la réponse.
 *
 * Le focus s'y pose à chaque verdict, succès comme échec. Trois effets d'un seul
 * geste : le navigateur amène l'encart dans la fenêtre même si le clic est venu
 * d'un raccourci qui l'avait fait défiler, le lecteur d'écran le lit sans
 * dépendre de la seule politesse de `role="status"`, et la navigation au clavier
 * repart de la réponse et non du haut du document. Le conteneur est
 * `tabIndex={-1}` : atteignable par script, jamais par tabulation, et le halo de
 * focus ne se peint qu'en `:focus-visible` — donc pas après un clic à la souris.
 *
 * ## Le slug n'est pas modifiable
 *
 * Il est l'adresse publique du salon : le changer casserait les liens partagés
 * et le référencement acquis. Le contrat l'exclut
 * (`updateTenantRequestSchema` ne le porte pas) et l'API le refuse ; le champ
 * est donc en lecture seule, avec la raison écrite à côté plutôt qu'une absence
 * inexpliquée.
 */

/** Les sept jours, en numérotation ISO 8601 — l'ordre de la grille. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** Plages éditables par jour — voir l'en-tête. */
const RANGES_PER_DAY = 2;

/**
 * La plage que « Ouvert » propose quand la journée n'en porte aucune.
 *
 * Les mêmes bornes que `newScheduleRow` de la semaine d'un praticien : la
 * journée type d'un salon commence le matin, et pré-remplir épargne deux saisies
 * sur trois. Elles restent modifiables — c'est une proposition, pas une règle.
 */
const PROPOSED_RANGE = { opensAt: '09:00', closesAt: '12:00' } as const;

/**
 * Une borne horaire de la grille : vide, ou une heure murale.
 *
 * `24:00` est admis des deux côtés du contrôle plutôt que de la seule fermeture.
 * Un début à `24:00` désignerait une plage vide, que le contrôle « fin > début »
 * refuse de toute façon — et le refuser deux fois rendrait deux messages pour
 * une seule faute.
 */
const boundSchema = z.union([
  z.literal(''),
  z.string().regex(/^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/, {
    message: 'heure attendue au format HH:MM (« 24:00 » pour minuit)',
  }),
]);

const rangeSchema = z
  .object({ opensAt: boundSchema, closesAt: boundSchema })
  .refine((range) => (range.opensAt === '') === (range.closesAt === ''), {
    message: 'renseignez l’ouverture et la fermeture, ou laissez les deux vides',
    path: ['closesAt'],
  })
  .refine((range) => range.opensAt === '' || range.closesAt > range.opensAt, {
    // Comparaison lexicographique : sur `HH:MM` à largeur fixe, elle coïncide
    // avec l'ordre horaire, et « 24:00 » y est bien la plus grande valeur.
    message: 'la fermeture doit être postérieure à l’ouverture',
    path: ['closesAt'],
  });

/**
 * Une journée de la grille : son état d'ouverture, puis ses plages.
 *
 * Le refus porte sur la journée entière et non sur une plage, parce que c'est la
 * journée qui est incohérente : « Ouvert » coché sans une seule plage complète
 * s'enregistrerait **fermé**, et l'interrupteur aurait menti. Le message se pose
 * sur la première ouverture — le champ par lequel on corrige — plutôt qu'en bloc
 * en haut d'écran (web-frontend §4).
 *
 * Une journée fermée n'est pas contrôlée, et n'a pas à l'être : décocher vide ses
 * champs, donc ses deux plages sont vides et passent `rangeSchema` sans rien dire.
 */
const daySchema = z
  .object({ open: z.boolean(), ranges: z.array(rangeSchema) })
  .refine(
    (day) => !day.open || day.ranges.some((range) => range.opensAt !== '' && range.closesAt !== ''),
    {
      message: 'renseignez une plage, ou décochez « Ouvert » pour fermer la journée',
      path: ['ranges', 0, 'opensAt'],
    },
  );

/**
 * Le schéma du formulaire — celui de la **saisie**, pas celui du contrat.
 *
 * Il diffère de `updateTenantRequestSchema` sur un point et un seul : la chaîne
 * vide y est licite partout, parce qu'un champ de formulaire vidé est vide et
 * non absent. La conversion « vide → `null` » se fait à l'envoi, et le contrat
 * revalide derrière (dans l'action serveur, puis dans l'API).
 */
const settingsFormSchema = z
  .object({
    name: displayNameSchema,
    contactEmail: z.union([z.literal(''), emailSchema]),
    contactPhone: z.union([z.literal(''), phoneSchema]),
    // Les bornes sont celles du contrat (`postalAddressSchema`) et donc celles
    // des colonnes. Sans elles, une ligne trop longue passerait la validation du
    // formulaire pour être refusée à l'envoi, sur un champ que rien ne
    // désignerait — le message doit se poser là où la saisie se corrige.
    line1: z.string().trim().max(ADDRESS_LINE_MAX_LENGTH),
    line2: z.string().trim().max(ADDRESS_LINE_MAX_LENGTH),
    postalCode: z.string().trim().max(POSTAL_CODE_MAX_LENGTH),
    city: z.string().trim().max(CITY_MAX_LENGTH),
    country: z.union([
      z.literal(''),
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, { message: 'code pays ISO 3166-1 alpha-2 attendu (« FR »)' }),
    ]),
    days: z.array(daySchema),
  })
  // L'adresse se publie en entier ou pas du tout : le triplet rue / ville / pays
  // va ensemble. La base porte la même règle
  // (`tenants_address_completeness_check`), et l'API la refuserait — mais un 500
  // de contrainte ne dirait pas quel champ manque, là où ce message le dit.
  .refine(
    (values) => {
      const filled = [values.line1, values.city, values.country].filter((part) => part !== '');
      return filled.length === 0 || filled.length === 3;
    },
    {
      message: 'renseignez la rue, la ville et le pays, ou laissez l’adresse entièrement vide',
      path: ['city'],
    },
  );

type SettingsFormValues = z.input<typeof settingsFormSchema>;

interface TenantSettingsFormProps {
  readonly tenantSlug: string;
  readonly tenant: Tenant;
}

/** Les plages du jour telles que la grille les pré-remplit — deux au plus. */
function editableRanges(tenant: Tenant, weekday: number): { opensAt: string; closesAt: string }[] {
  const ofDay = (tenant.openingHours ?? []).filter((entry) => entry.weekday === weekday);

  return Array.from({ length: RANGES_PER_DAY }, (_unused, index) => {
    const entry = ofDay[index];
    return { opensAt: entry?.opensAt ?? '', closesAt: entry?.closesAt ?? '' };
  });
}

/**
 * La journée est-elle ouverte ? — c'est-à-dire porte-t-elle une plage.
 *
 * L'état initial de l'interrupteur se **déduit** des horaires, il ne se stocke
 * pas : le contrat ne connaît que des plages, et une journée sans plage est une
 * journée fermée. Un salon qui n'a encore rien renseigné ouvre donc l'écran avec
 * sept journées fermées — ce qui est la vérité de ce que sa page publique
 * affiche, là où sept lignes de champs vides laissaient croire à une semaine en
 * cours de saisie.
 */
function isOpenOn(tenant: Tenant, weekday: number): boolean {
  return (tenant.openingHours ?? []).some((entry) => entry.weekday === weekday);
}

/**
 * Les plages qu'aucun champ de la grille ne montre — voir l'en-tête.
 *
 * Elles sont renvoyées à l'identique pour que « Enregistrer » ne les efface pas.
 */
function hiddenRanges(tenant: Tenant): readonly OpeningHoursEntry[] {
  const seen = new Map<number, number>();

  return (tenant.openingHours ?? []).filter((entry) => {
    const rank = seen.get(entry.weekday) ?? 0;
    seen.set(entry.weekday, rank + 1);
    return rank >= RANGES_PER_DAY;
  });
}

/**
 * Le verdict du dernier enregistrement — succès, ou refus et sa raison.
 *
 * Un seul état pour les deux tons : ils s'excluent, et les tenir séparément
 * ouvrait la porte à les afficher tous les deux.
 */
type Verdict = { readonly tone: 'success' } | { readonly tone: 'danger'; readonly message: string };

export function TenantSettingsForm({ tenantSlug, tenant }: TenantSettingsFormProps) {
  const router = useRouter();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const verdictRef = useRef<HTMLDivElement | null>(null);
  const carriedOver = hiddenRanges(tenant);

  /**
   * Les jours dont la fermeture a emporté les plages surnuméraires.
   *
   * Fermer une journée la ferme **entièrement**, plages invisibles comprises. La
   * rouvrir ne les ressuscite donc pas : sans cette mémoire, décocher puis
   * recocher le mercredi renverrait la troisième plage qu'aucun champ ne montre
   * — la journée repartirait avec des heures que personne n'a saisies, et la
   * plage proposée pourrait même la recouvrir, pour un refus désignant un
   * horaire introuvable à l'écran.
   *
   * Un `ref` et non un état : la grille ne se repeint pas pour autant, et la
   * liste est relue au seul moment où elle sert, l'enregistrement.
   */
  const droppedHiddenRanges = useRef(new Set<number>());

  /**
   * Amener le verdict sous les yeux — voir l'en-tête.
   *
   * La dépendance est l'objet `verdict` entier, et chaque verdict en pose un
   * neuf : deux refus au message identique restent deux valeurs distinctes,
   * donc l'effet se rejoue et le focus se repose. Deux `useState` séparés ne
   * l'auraient pas fait — sur les chemins de validation locale, le
   * `setVerdict(null)` de tête et la pose du verdict tombent dans le même lot de
   * rendu, si bien qu'un message répété n'aurait changé aucune dépendance.
   */
  useEffect(() => {
    if (verdict === null) {
      return;
    }

    verdictRef.current?.focus();
  }, [verdict]);

  const {
    control,
    register,
    setValue,
    clearErrors,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SettingsFormValues, unknown, z.output<typeof settingsFormSchema>>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: {
      name: tenant.name,
      contactEmail: tenant.contactEmail ?? '',
      contactPhone: tenant.contactPhone ?? '',
      line1: tenant.address?.line1 ?? '',
      line2: tenant.address?.line2 ?? '',
      postalCode: tenant.address?.postalCode ?? '',
      city: tenant.address?.city ?? '',
      country: tenant.address?.country ?? '',
      days: WEEKDAYS.map((weekday) => ({
        open: isOpenOn(tenant, weekday),
        ranges: editableRanges(tenant, weekday),
      })),
    },
    mode: 'onTouched',
  });

  /**
   * L'état d'ouverture des sept jours, tel que la grille le peint.
   *
   * Souscrire à `days` plutôt qu'aux sept interrupteurs un à un : les noms de
   * champ d'un tableau ne se composent pas dans une boucle de hooks, et cet
   * écran ne peint que soixante nœuds — le coût du rendu supplémentaire à la
   * frappe est sans commune mesure avec celui d'un second état à tenir synchrone
   * avec le formulaire.
   */
  const days = useWatch({ control, name: 'days' });

  /**
   * Ouvrir ou fermer une journée — voir l'en-tête.
   *
   * Décocher **vide** les champs du jour et efface ses erreurs : ils ne sont plus
   * affichés, et une saisie laissée derrière eux se jugerait sans pouvoir se
   * corriger. Recocher propose une plage quand la journée n'en porte aucune,
   * plutôt que de rendre quatre champs vides — c'est-à-dire l'état même qu'on
   * vient de rendre lisible.
   */
  function toggleDay(dayIndex: number, open: boolean): void {
    if (!open) {
      for (let rangeIndex = 0; rangeIndex < RANGES_PER_DAY; rangeIndex += 1) {
        setValue(`days.${dayIndex}.ranges.${rangeIndex}.opensAt` as const, '');
        setValue(`days.${dayIndex}.ranges.${rangeIndex}.closesAt` as const, '');
      }
      clearErrors(`days.${dayIndex}` as const);

      const weekday = WEEKDAYS[dayIndex];

      if (weekday !== undefined) {
        droppedHiddenRanges.current.add(weekday);
      }

      return;
    }

    const ranges = days[dayIndex]?.ranges ?? [];

    if (ranges.every((range) => range.opensAt === '' && range.closesAt === '')) {
      setValue(`days.${dayIndex}.ranges.0.opensAt` as const, PROPOSED_RANGE.opensAt);
      setValue(`days.${dayIndex}.ranges.0.closesAt` as const, PROPOSED_RANGE.closesAt);
    }
  }

  const submit = handleSubmit(
    async (values) => {
      setVerdict(null);

      const openingHours: OpeningHoursEntry[] = [];
      const openWeekdays = new Set<number>();

      values.days.forEach((day, index) => {
        const weekday = WEEKDAYS[index];
        if (weekday === undefined || !day.open) {
          return;
        }
        openWeekdays.add(weekday);
        for (const range of day.ranges) {
          if (range.opensAt !== '' && range.closesAt !== '') {
            openingHours.push({ weekday, opensAt: range.opensAt, closesAt: range.closesAt });
          }
        }
      });

      // Les plages surnuméraires d'une journée **fermée** ne se reportent pas.
      // Les conserver ferait de « Fermé » un affichage sans effet : la troisième
      // plage du mercredi, qu'aucun champ ne montre, rouvrirait la journée au
      // premier enregistrement — et l'écran affirmerait le contraire de ce que
      // la page publique affiche. Fermer une journée la ferme entièrement — et
      // la rouvrir dans la foulée ne la rouvre pas avec ses heures d'avant, d'où
      // la seconde condition.
      const kept = carriedOver.filter(
        (entry) =>
          openWeekdays.has(entry.weekday) && !droppedHiddenRanges.current.has(entry.weekday),
      );

      // `safeParse` et non `parse` : le schéma du formulaire ne porte pas toutes
      // les règles du contrat — le recouvrement de deux plages du même jour porte
      // sur l'ensemble de la semaine, plages reportées comprises, et se voit donc
      // ici seulement. Une exception levée dans ce rappel remonte telle quelle
      // depuis `handleSubmit` : l'écran n'afficherait rien, le bouton reprendrait
      // son état de repos, et rien n'aurait été enregistré — un échec muet, la
      // pire des réponses.
      const address =
        values.line1 === ''
          ? null
          : postalAddressSchema.safeParse({
              line1: values.line1,
              ...(values.line2 === '' ? {} : { line2: values.line2 }),
              ...(values.postalCode === '' ? {} : { postalCode: values.postalCode }),
              city: values.city,
              country: values.country,
            });

      if (address !== null && !address.success) {
        setVerdict({
          tone: 'danger',
          message: address.error.issues[0]?.message ?? 'L’adresse saisie est invalide.',
        });
        return;
      }

      const week = openingHoursSchema.safeParse([...openingHours, ...kept]);

      if (!week.success) {
        setVerdict({
          tone: 'danger',
          message: week.error.issues[0]?.message ?? 'Les horaires saisis sont invalides.',
        });
        return;
      }

      const changes: UpdateTenantRequest = {
        name: values.name,
        // `null` efface ; la chaîne vide n'est pas une valeur du contrat.
        contactEmail: values.contactEmail === '' ? null : values.contactEmail,
        contactPhone: values.contactPhone === '' ? null : values.contactPhone,
        address: address === null ? null : address.data,
        openingHours: [...week.data],
      };

      const result = await updateTenantSettingsAction(tenantSlug, changes);

      if (!result.ok) {
        setVerdict({ tone: 'danger', message: result.message });
        return;
      }

      setVerdict({ tone: 'success' });
      // La page est rendue côté serveur : sans ce rafraîchissement, elle
      // continuerait d'afficher les valeurs d'avant l'enregistrement.
      router.refresh();
    },
    /*
     * Soumission refusée par la validation des champs : rien n'a été envoyé, donc
     * le verdict précédent ne vaut plus. Sans ce rappel, `handleSubmit` n'appelle
     * pas du tout le premier — et un « Réglages enregistrés » d'un enregistrement
     * antérieur resterait peint juste au-dessus du bouton, à affirmer le contraire
     * de ce qui vient de se passer. Les erreurs de champ, elles, se lisent sous
     * chaque champ.
     */
    () => {
      setVerdict(null);
    },
  );

  return (
    <section aria-labelledby="reglages-titre">
      <h1 className="spa-admin__title" id="reglages-titre">
        Réglages de l’établissement
      </h1>

      <form className="spa-admin__content" onSubmit={(event) => void submit(event)} noValidate>
        <Field
          id="tenant-name"
          label="Nom de l’établissement"
          required
          error={errors.name?.message}
          {...register('name')}
        />
        <Field
          id="tenant-slug"
          label="Adresse publique"
          value={tenantSlug}
          readOnly
          hint="L’adresse de votre page publique. Contactez le support pour en changer."
        />

        <fieldset className="spa-admin__section" aria-labelledby="reglages-adresse">
          <legend className="spa-admin__section-title" id="reglages-adresse">
            Adresse postale
          </legend>
          <p className="spa-admin-toolbar__hint">
            Publiée sur la page du salon. Laissez la rue, la ville et le pays vides pour ne rien
            publier.
          </p>
          <Field
            id="tenant-address-line1"
            label="Numéro et voie"
            autoComplete="address-line1"
            error={errors.line1?.message}
            {...register('line1')}
          />
          <Field
            id="tenant-address-line2"
            label="Complément"
            autoComplete="address-line2"
            hint="Bâtiment, étage, boîte. Facultatif."
            error={errors.line2?.message}
            {...register('line2')}
          />
          <Field
            id="tenant-postal-code"
            label="Code postal"
            autoComplete="postal-code"
            error={errors.postalCode?.message}
            {...register('postalCode')}
          />
          <Field
            id="tenant-city"
            label="Ville"
            autoComplete="address-level2"
            error={errors.city?.message}
            {...register('city')}
          />
          <Field
            id="tenant-country"
            label="Pays"
            autoComplete="country"
            hint="Code à deux lettres : FR, BE, MG…"
            error={errors.country?.message}
            {...register('country')}
          />
        </fieldset>

        <fieldset className="spa-admin__section" aria-labelledby="reglages-horaires">
          <legend className="spa-admin__section-title" id="reglages-horaires">
            Horaires d’ouverture
          </legend>
          <p className="spa-admin-toolbar__hint">
            Décochez « Ouvert » pour une journée de fermeture ; deux plages permettent d’indiquer
            une coupure méridienne.
          </p>
          <div className="spa-admin-schedule">
            {WEEKDAYS.map((weekday, dayIndex) => {
              const day = weekdayLabel(weekday);
              const dayLabelId = `tenant-hours-${String(weekday)}-jour`;
              const toggleId = `tenant-hours-${String(weekday)}-ouvert`;
              const open = days[dayIndex]?.open ?? false;
              // Le rappel de `register` est enveloppé et non remplacé : c'est lui
              // qui porte la valeur au formulaire, et le nôtre ne fait que
              // rattraper les champs du jour derrière lui.
              const openField = register(`days.${dayIndex}.open` as const);

              return (
                <div
                  aria-labelledby={dayLabelId}
                  className="spa-admin-schedule__day"
                  key={weekday}
                  role="group"
                >
                  <p className="spa-admin-schedule__day-label" id={dayLabelId}>
                    {day}
                  </p>
                  <span className="spa-admin-schedule__toggle">
                    <input
                      {...openField}
                      // Sept interrupteurs pour un seul libellé visible : le jour
                      // ne se lit qu'à l'œil, dans la colonne d'à côté. Le nom
                      // accessible l'ajoute, et **s'ouvre** par le libellé visible
                      // — sans quoi « Ouvert » prononcé à une commande vocale ne
                      // désignerait plus rien (WCAG 2.5.3), comme pour les 28
                      // champs d'horaire de la même grille (#621).
                      aria-label={`Ouvert le ${day.toLowerCase()}`}
                      id={toggleId}
                      onChange={(event) => {
                        void openField.onChange(event);
                        toggleDay(dayIndex, event.target.checked);
                      }}
                      type="checkbox"
                    />
                    <label htmlFor={toggleId}>Ouvert</label>
                  </span>
                  <div className="spa-admin-schedule__ranges">
                    {!open ? (
                      <span className="spa-admin-schedule__closed">
                        Fermé — aucun créneau proposé
                      </span>
                    ) : (
                      Array.from({ length: RANGES_PER_DAY }, (_unused, rangeIndex) => {
                        const rank = String(rangeIndex + 1);
                        const opens = `Ouverture ${rank}`;
                        const closes = `Fermeture ${rank}`;

                        return (
                          <div className="spa-admin-schedule__range" key={rangeIndex}>
                            <Field
                              aria-label={`${opens} du ${day.toLowerCase()}`}
                              id={`tenant-hours-${String(weekday)}-${String(rangeIndex)}-opens`}
                              label={opens}
                              placeholder="09:00"
                              inputMode="numeric"
                              error={
                                errors.days?.[dayIndex]?.ranges?.[rangeIndex]?.opensAt?.message
                              }
                              {...register(
                                `days.${dayIndex}.ranges.${rangeIndex}.opensAt` as const,
                              )}
                            />
                            <Field
                              aria-label={`${closes} du ${day.toLowerCase()}`}
                              id={`tenant-hours-${String(weekday)}-${String(rangeIndex)}-closes`}
                              label={closes}
                              placeholder="12:00"
                              inputMode="numeric"
                              error={
                                errors.days?.[dayIndex]?.ranges?.[rangeIndex]?.closesAt?.message ??
                                errors.days?.[dayIndex]?.ranges?.[rangeIndex]?.root?.message
                              }
                              {...register(
                                `days.${dayIndex}.ranges.${rangeIndex}.closesAt` as const,
                              )}
                            />
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {/*
            Sous les champs, et non au-dessus : c'est là que le README §3 place
            le fuseau du salon, c'est-à-dire là où l'on vient de saisir une heure
            et où la question « dans quel fuseau ? » se pose. Les mots sont ceux
            de la fiche praticien, au nom du fuseau près.
          */}
          <p className="spa-admin-toolbar__hint">
            Heures écrites dans le fuseau du salon ({tenant.timezone}), stockées en UTC.
          </p>
        </fieldset>

        <fieldset className="spa-admin__section" aria-labelledby="reglages-contact">
          <legend className="spa-admin__section-title" id="reglages-contact">
            Coordonnées
          </legend>
          <Field
            id="tenant-contact-email"
            label="E-mail de contact"
            type="email"
            autoComplete="email"
            hint="Laissez vide pour ne pas publier d’adresse."
            error={errors.contactEmail?.message}
            {...register('contactEmail')}
          />
          <Field
            id="tenant-contact-phone"
            label="Téléphone"
            type="tel"
            autoComplete="tel"
            hint="Laissez vide pour ne pas publier de numéro."
            error={errors.contactPhone?.message}
            {...register('contactPhone')}
          />
        </fieldset>

        {verdict === null ? null : (
          // Dernier enfant du formulaire avant le bouton : le verdict se lit là
          // où le geste a eu lieu (#635). L'enveloppe porte les deux tons pour
          // ne tenir qu'un seul point de focus, quel que soit celui qui s'affiche.
          <div ref={verdictRef} tabIndex={-1}>
            {verdict.tone === 'success' ? (
              <Notification tone="success" title="Réglages enregistrés">
                <p>La page publique du salon affiche désormais ces informations.</p>
              </Notification>
            ) : (
              <Notification tone="danger" title="L’enregistrement a échoué">
                <p>{verdict.message}</p>
              </Notification>
            )}
          </div>
        )}

        <Button
          type="submit"
          variant="accent"
          block
          loading={isSubmitting}
          loadingLabel="Enregistrement…"
        >
          Enregistrer
        </Button>
      </form>
    </section>
  );
}
