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
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { WEEKDAY_LABELS } from '@/components/salon/opening-hours';

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
    days: z.array(z.object({ ranges: z.array(rangeSchema) })),
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

export function TenantSettingsForm({ tenantSlug, tenant }: TenantSettingsFormProps) {
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const carriedOver = hiddenRanges(tenant);

  const {
    register,
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
      days: WEEKDAYS.map((weekday) => ({ ranges: editableRanges(tenant, weekday) })),
    },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    setSaved(false);

    const openingHours: OpeningHoursEntry[] = [];

    values.days.forEach((day, index) => {
      const weekday = WEEKDAYS[index];
      if (weekday === undefined) {
        return;
      }
      for (const range of day.ranges) {
        if (range.opensAt !== '' && range.closesAt !== '') {
          openingHours.push({ weekday, opensAt: range.opensAt, closesAt: range.closesAt });
        }
      }
    });

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
      setFailure(address.error.issues[0]?.message ?? 'L’adresse saisie est invalide.');
      return;
    }

    const week = openingHoursSchema.safeParse([...openingHours, ...carriedOver]);

    if (!week.success) {
      setFailure(week.error.issues[0]?.message ?? 'Les horaires saisis sont invalides.');
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
      setFailure(result.message);
      return;
    }

    setSaved(true);
    // La page est rendue côté serveur : sans ce rafraîchissement, elle
    // continuerait d'afficher les valeurs d'avant l'enregistrement.
    router.refresh();
  });

  return (
    <section aria-labelledby="reglages-titre">
      <h1 className="spa-admin__title" id="reglages-titre">
        Réglages de l’établissement
      </h1>

      {saved ? (
        <Notification tone="success" title="Réglages enregistrés">
          <p>La page publique du salon affiche désormais ces informations.</p>
        </Notification>
      ) : null}

      {failure === null ? null : (
        <Notification tone="danger" title="L’enregistrement a échoué">
          <p>{failure}</p>
        </Notification>
      )}

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
            Heures de votre horloge. Laissez une journée vide si le salon est fermé ; deux plages
            permettent d’indiquer une coupure.
          </p>
          <div className="spa-admin-schedule">
            {WEEKDAYS.map((weekday, dayIndex) => (
            <div className="spa-admin-schedule__day" key={weekday}>
              <p className="spa-admin-schedule__day-label">{WEEKDAY_LABELS[weekday]}</p>
              <div className="spa-admin-schedule__ranges">
              {Array.from({ length: RANGES_PER_DAY }, (_unused, rangeIndex) => (
                <div className="spa-admin-schedule__range" key={rangeIndex}>
                  <Field
                    id={`tenant-hours-${String(weekday)}-${String(rangeIndex)}-opens`}
                    label={`Ouverture ${String(rangeIndex + 1)}`}
                    placeholder="09:00"
                    inputMode="numeric"
                    error={errors.days?.[dayIndex]?.ranges?.[rangeIndex]?.opensAt?.message}
                    {...register(`days.${dayIndex}.ranges.${rangeIndex}.opensAt` as const)}
                  />
                  <Field
                    id={`tenant-hours-${String(weekday)}-${String(rangeIndex)}-closes`}
                    label={`Fermeture ${String(rangeIndex + 1)}`}
                    placeholder="12:00"
                    inputMode="numeric"
                    error={
                      errors.days?.[dayIndex]?.ranges?.[rangeIndex]?.closesAt?.message ??
                      errors.days?.[dayIndex]?.ranges?.[rangeIndex]?.root?.message
                    }
                    {...register(`days.${dayIndex}.ranges.${rangeIndex}.closesAt` as const)}
                  />
                </div>
              ))}
              </div>
            </div>
          ))}
          </div>
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
