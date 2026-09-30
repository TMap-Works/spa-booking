'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  countryUsesAddressRegion,
  createTenantRequestSchema,
  resourceSlugSchema,
  type CreateTenantRequest,
  type Locale,
  type ProvisionedTenant,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { SUPPORTED_LOCALES } from '@/i18n/resolve';
import { useLocalizedFieldErrors } from '@/lib/field-refusal';

import { provisionTenantAction } from '../actions';
import { PLATFORM_TENANTS_PATH, platformTenantPath } from '../paths';
import { PLATFORM_SESSION_END_PATH } from '../session/fin/path';
import { AccessLinks } from './access-links';
import {
  CURRENCY_CHOICES as CURRENCIES,
  DEFAULT_COUNTRY,
  countryChoices,
  countryPreset,
  slugifySalonName as slugify,
  timezoneChoices,
} from '@/lib/salon-presets';

/**
 * Le formulaire d'ouverture d'un salon.
 *
 * ## Le pays règle le reste
 *
 * Choisir le pays pose la devise qui lui va et le premier de ses fuseaux, et
 * borne les fuseaux proposés à ceux de ce pays — les deux restent modifiables
 * (#1103). Un salon ouvert dans le mauvais fuseau affiche tous ses créneaux
 * décalés (CLAUDE.md, « sévérité haute ») : le préremplir évite l'oubli le plus
 * probable, et restreindre la liste évite le second.
 *
 * Les **noms** des pays viennent d'`Intl.DisplayNames` et non d'une table du
 * dépôt (`lib/salon-presets.ts`, #1105) : la plateforme les connaît déjà dans les
 * deux langues, et une table maison aurait fini par diverger de l'ISO 3166.
 *
 * ## L'adresse du salon suit son nom
 *
 * Tant qu'on ne l'a pas touchée, l'adresse (`/maison-lotus`) se déduit du nom.
 * La modifier à la main la détache.
 *
 * ## La langue du salon n'est pas celle de l'opérateur (#1106)
 *
 * Un opérateur qui travaille en français ouvre le plus souvent des salons
 * anglophones : la clientèle du produit est nord-américaine (décision du PO du
 * 2026-09-19). Le champ présélectionne donc **`en`**, le défaut du système
 * (#844) — celui que l'API poserait de toute façon si le champ était absent —, et
 * non la langue de la console. Les deux questions sont distinctes, et les
 * confondre aurait ouvert en français tous les salons d'un opérateur francophone.
 *
 * ## Les refus sont lus sur le code, les champs traduits par champ
 *
 * Les messages de `createTenantRequestSchema` sont des littéraux français quand
 * ils existent, et le message anglais brut de Zod sinon : `packages/shared` est
 * lu par l'API autant que par le front et n'a pas de langue de requête. L'écran
 * traduit donc par champ, et les refus de l'API par code — jamais en recopiant
 * `result.message`, qui rendrait un écran anglais bilingue à la première erreur.
 *
 * ## Et ce qu'il garde est la **clé**, pas la phrase (#1354)
 *
 * La clé était lue dans {@link ERROR_KEYS} puis traduite aussitôt, et c'est la
 * phrase qui allait en état. Or le sélecteur de langue pose un cookie et laisse
 * Next rejouer la route **sans navigation** (`i18n/actions.ts`) : ce formulaire
 * n'est pas démonté, son état ne bouge pas, et la phrase restait écrite dans la
 * langue d'avant sous un titre qui, lui, suivait le rendu. Même défaut sous les
 * champs, pour les deux refus que l'API pose en propre — `useLocalizedFieldErrors`
 * les réécrit depuis leur code (`lib/field-refusal.ts`). Le précédent du bandeau
 * est `platform-login-form.tsx` (#1106), dans le même dossier.
 *
 * ## Une clé d'idempotence par salon
 *
 * Tirée au montage et renouvelée seulement quand on ouvre un autre salon : un
 * double clic, ou une soumission rejouée après une coupure, rend le salon déjà
 * ouvert au lieu d'en créer un second.
 */

/**
 * La langue du salon présélectionnée — `en`, le défaut du système (#844).
 *
 * Écrite ici et non lue de `DEFAULT_LOCALE` : c'est une décision de **ce
 * formulaire** — le pari le moins souvent faux pour un salon nord-américain —, et
 * non la langue de repli du front. Les deux valent `en` aujourd'hui ; les
 * confondre ferait basculer ce champ le jour où l'une des deux changerait.
 */
const DEFAULT_SALON_LOCALE: Locale = 'en';

const EMPTY_VALUES: CreateTenantRequest = {
  name: '',
  slug: '',
  addressLine1: '',
  addressLine2: '',
  postalCode: '',
  city: '',
  region: '',
  countryCode: DEFAULT_COUNTRY.code,
  timezone: DEFAULT_COUNTRY.timezones[0],
  defaultCurrency: DEFAULT_COUNTRY.currency,
  defaultLocale: DEFAULT_SALON_LOCALE,
  adminFirstName: '',
  adminLastName: '',
  adminEmail: '',
};

/**
 * Le type dont Zod marque un `refine`.
 *
 * Il ne suffit pas à désigner le slug réservé : depuis #1232 la **forme** du
 * slug est elle aussi un `refine` — c'est ce qui lui permet de porter une clé de
 * message traduisible —, et rend donc le même code. C'est {@link slugReserved}
 * qui tranche.
 */
const CUSTOM_FIELD_ERROR = 'custom';

/**
 * `true` si la valeur saisie est refusée **parce qu'elle est réservée**, et non
 * parce qu'elle est mal formée.
 *
 * `slugSchema` est `resourceSlugSchema` plus la liste des noms que la plateforme
 * garde : une adresse que le second accepte et que le premier refuse est donc
 * réservée, et pas autre chose.
 */
function slugReserved(value: unknown): boolean {
  return resourceSlugSchema.safeParse(value).success;
}

/** Ce qu'un champ refusé annonce — un message par champ, jamais par code de Zod. */
const FIELD_ERROR_KEYS = {
  name: 'create.fieldErrors.name',
  slug: 'create.fieldErrors.slug',
  addressLine1: 'create.fieldErrors.addressLine1',
  addressLine2: 'create.fieldErrors.addressLine2',
  postalCode: 'create.fieldErrors.postalCode',
  city: 'create.fieldErrors.city',
  region: 'create.fieldErrors.region',
  countryCode: 'create.fieldErrors.countryCode',
  timezone: 'create.fieldErrors.timezone',
  defaultCurrency: 'create.fieldErrors.defaultCurrency',
  defaultLocale: 'create.fieldErrors.defaultLocale',
  adminFirstName: 'create.fieldErrors.adminFirstName',
  adminLastName: 'create.fieldErrors.adminLastName',
  adminEmail: 'create.fieldErrors.adminEmail',
} as const;

type CreateFieldName = keyof typeof FIELD_ERROR_KEYS;

/** Les clés du catalogue qu'un refus de l'API peut désigner. */
type CreateErrorKey =
  | 'errors.validation'
  | 'errors.tooManyRequests'
  | 'errors.unavailable'
  | 'errors.unexpected';

/**
 * Ce que chaque refus de l'API devient à l'écran, dans la langue lue.
 *
 * `EMAIL_ALREADY_REGISTERED` n'y figure pas : il désigne un champ, et
 * {@link TenantCreateForm} le pose sur `adminEmail` avant d'arriver ici — un
 * bandeau en haut de page pour un refus qui a son champ serait la faute que
 * web-frontend §4 nomme.
 */
const ERROR_KEYS: Readonly<Record<string, CreateErrorKey>> = {
  [ERROR_CODES.VALIDATION_ERROR]: 'errors.validation',
  [ERROR_CODES.BAD_REQUEST]: 'errors.validation',
  [ERROR_CODES.BUSINESS_RULE_VIOLATION]: 'errors.validation',
  [ERROR_CODES.TOO_MANY_REQUESTS]: 'errors.tooManyRequests',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'errors.unavailable',
  [ERROR_CODES.INTERNAL_ERROR]: 'errors.unexpected',
};

export function TenantCreateForm() {
  const t = useTranslations('platform');
  // Les noms de langues sont ceux du sélecteur de la coquille : « Français » et
  // « English », chacun dans la sienne, identiques dans les deux catalogues
  // (#845). Les redire ici en aurait fait une seconde écriture.
  const languages = useTranslations('locale');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [slugTouched, setSlugTouched] = useState(false);
  /** La **clé** du refus, pas sa phrase (#1354) — voir l'en-tête de ce module. */
  const [failure, setFailure] = useState<CreateErrorKey | null>(null);
  const [opened, setOpened] = useState<ProvisionedTenant | null>(null);

  const countries = useMemo(() => countryChoices(locale), [locale]);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    reset,
    trigger,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CreateTenantRequest, unknown, z.output<typeof createTenantRequestSchema>>({
    resolver: zodResolver(createTenantRequestSchema),
    defaultValues: EMPTY_VALUES,
    mode: 'onTouched',
  });

  /**
   * Les deux refus que l'API pose **sur un champ** suivent la langue — #1354.
   *
   * Ils étaient posés avec leur phrase, et rien ne la recalculait : « Cette
   * adresse web est déjà prise. » restait sous un champ « Web address » après une
   * bascule. Ils sont donc posés par leur **code**, et le crochet les réécrit —
   * ce qui les exclut aussi du rejeu de validation, sans quoi le schéma
   * trouverait l'adresse valable et effacerait le refus.
   */
  const { postFieldRefusal, clearFieldRefusals } = useLocalizedFieldErrors({
    locale,
    errors,
    trigger,
    setError,
    own: (code) =>
      code === ERROR_CODES.TENANT_SLUG_TAKEN
        ? t('create.fieldErrors.slugTaken')
        : code === ERROR_CODES.EMAIL_ALREADY_REGISTERED
          ? t('create.errors.emailTaken')
          : null,
  });

  /**
   * Ce qu'affiche un champ refusé — rien s'il ne l'est pas.
   *
   * Un refus de l'API garde son propre message ; un refus de schéma prend celui
   * du catalogue.
   */
  const fieldError = (name: CreateFieldName): string | undefined => {
    const error = errors[name];

    if (error === undefined) {
      return undefined;
    }
    /*
     * Un refus **posé par l'API** n'a pas de `type` : `postFieldRefusal` appelle
     * `setError(name, { message })`, quand le résolveur de Zod marque chacun des
     * siens du code de l'issue (`{ message, type: issue.code }`). Sa phrase est
     * déjà celle du catalogue, et `useLocalizedFieldErrors` la réécrit à chaque
     * changement de langue — on la rend telle quelle.
     *
     * La lecture est élargie parce que `FieldError` déclare `type` obligatoire :
     * une comparaison directe à `undefined` serait refusée par `tsc` alors que
     * c'est exactement ce que `setError` laisse.
     */
    const refusedBy: string | undefined = (error as { type?: string }).type;

    if (refusedBy === undefined) {
      return error.message;
    }
    // Le slug a deux façons d'être refusé — sa forme, et sa disponibilité. Les
    // confondre demanderait des minuscules et des tirets à qui en a déjà mis.
    if (name === 'slug' && refusedBy === CUSTOM_FIELD_ERROR && slugReserved(watch('slug'))) {
      return t('create.fieldErrors.slugReserved');
    }

    return t(FIELD_ERROR_KEYS[name]);
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    clearFieldRefusals();
    const result = await provisionTenantAction(idempotencyKey, values);

    if (result.ok) {
      setOpened(result.data);
      router.refresh();
      return;
    }
    if (result.code === ERROR_CODES.UNAUTHORIZED) {
      router.replace(PLATFORM_SESSION_END_PATH);
      return;
    }
    // Un refus qui désigne un champ s'affiche **sur** ce champ, jamais en bloc
    // en haut de page (web-frontend §4) — et par son **code**, pour qu'il suive
    // la langue comme le reste (#1354).
    if (result.code === ERROR_CODES.TENANT_SLUG_TAKEN) {
      postFieldRefusal('slug', result.code);
      return;
    }
    if (result.code === ERROR_CODES.EMAIL_ALREADY_REGISTERED) {
      postFieldRefusal('adminEmail', result.code);
      return;
    }
    setFailure(ERROR_KEYS[result.code] ?? 'errors.unexpected');
  });

  const openAnother = (): void => {
    reset(EMPTY_VALUES);
    setSlugTouched(false);
    setOpened(null);
    setFailure(null);
    setIdempotencyKey(crypto.randomUUID());
  };

  if (opened !== null) {
    return (
      <div className="spa-admin__section">
        <Notification
          tone="success"
          title={
            opened.replayed
              ? t('create.replayedTitle', { name: opened.tenant.name })
              : t('create.openedTitle', { name: opened.tenant.name })
          }
        >
          <p>
            {t('create.openedBody', {
              firstName: opened.admin.firstName,
              lastName: opened.admin.lastName,
              email: opened.admin.email,
            })}
          </p>
        </Notification>

        <AccessLinks idPrefix="nouveau-salon" links={opened.links} />

        <div className="spa-admin-toolbar">
          <span className="spa-admin-toolbar__spacer" />
          <div className="spa-admin-toolbar__group">
            <Button variant="neutral" onClick={openAnother}>
              {t('create.openAnother')}
            </Button>
            <Link
              className="spa-button spa-button--accent"
              href={platformTenantPath(opened.tenant.id)}
            >
              {t('create.seeRecord')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const nameField = register('name');
  const slugField = register('slug');
  const countryField = register('countryCode');
  // Nommés dans la langue lue — « Eastern Time (New York) » plutôt que
  // « America/New_York » (#1330). La valeur soumise reste l'identifiant IANA.
  //
  // Pas de `useMemo` ici, contrairement à l'inscription : ce composant rend un
  // écran de succès par un retour anticipé au-dessus, et un `useMemo` placé
  // après serait un appel conditionnel de hook.
  //
  // Le pays est lu une fois et sert deux fois : les fuseaux proposés, et
  // l'affichage du champ État/Province (#1335).
  const country = watch('countryCode');
  const timezones = timezoneChoices(country, locale);

  return (
    <form className="spa-platform-form" onSubmit={(event) => void submit(event)} noValidate>
      {failure === null ? null : (
        <Notification tone="danger" title={t('create.failureTitle')}>
          {/* La phrase est écrite ici, dans la langue de ce rendu (#1354). */}
          <p>{t(failure)}</p>
        </Notification>
      )}

      <fieldset className="spa-admin__section spa-platform-form__group">
        <legend className="spa-admin__section-title">{t('create.salonLegend')}</legend>
        <Field
          id="salon-nom"
          label={t('create.name')}
          required
          error={fieldError('name')}
          {...nameField}
          onChange={(event) => {
            void nameField.onChange(event);
            if (!slugTouched) {
              setValue('slug', slugify(event.target.value), { shouldValidate: false });
            }
          }}
        />
        <Field
          id="salon-adresse-web"
          label={t('create.slug')}
          hint={t('create.slugHint')}
          required
          error={fieldError('slug')}
          {...slugField}
          onChange={(event) => {
            setSlugTouched(true);
            void slugField.onChange(event);
          }}
        />
        <Field
          id="salon-adresse"
          label={t('create.addressLine1')}
          autoComplete="address-line1"
          required
          error={fieldError('addressLine1')}
          {...register('addressLine1')}
        />
        <Field
          id="salon-adresse-complement"
          label={t('create.addressLine2')}
          autoComplete="address-line2"
          error={fieldError('addressLine2')}
          {...register('addressLine2')}
        />
        <div className="spa-platform-form__row">
          <Field
            id="salon-code-postal"
            label={t('create.postalCode')}
            autoComplete="postal-code"
            error={fieldError('postalCode')}
            {...register('postalCode')}
          />
          <Field
            id="salon-ville"
            label={t('create.city')}
            autoComplete="address-level2"
            required
            error={fieldError('city')}
            {...register('city')}
          />
          {/*
           * L'État ou la province, pour les seuls pays qui en portent un (#1335).
           * Facultatif même affiché : l'opératrice qui ouvre un salon n'a pas
           * toujours l'adresse complète sous les yeux, et la gérante le
           * complétera dans ses réglages.
           */}
          {countryUsesAddressRegion(country) ? (
            <Field
              id="salon-region"
              label={t('create.region')}
              autoComplete="address-level1"
              error={fieldError('region')}
              {...register('region')}
            />
          ) : null}
        </div>
        <div className="spa-platform-form__row">
          <Select
            id="salon-pays"
            label={t('create.country')}
            error={fieldError('countryCode')}
            {...countryField}
            onChange={(event) => {
              void countryField.onChange(event);
              const preset = countryPreset(event.target.value);
              if (preset !== undefined) {
                setValue('timezone', preset.timezones[0]);
                setValue('defaultCurrency', preset.currency);
              }
              // Changer pour un pays sans subdivision **efface** l'État saisi
              // (#1335) : le champ disparaît, et une valeur qu'on ne voit plus
              // partirait sinon en base — « NY » sur une adresse parisienne.
              if (!countryUsesAddressRegion(event.target.value)) {
                setValue('region', '');
              }
            }}
          >
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.label}
              </option>
            ))}
          </Select>
          <Select
            id="salon-fuseau"
            label={t('create.timezone')}
            hint={t('create.timezoneHint')}
            error={fieldError('timezone')}
            {...register('timezone')}
          >
            {timezones.map((choice) => (
              <option key={choice.timezone} value={choice.timezone}>
                {choice.label}
              </option>
            ))}
          </Select>
          <Select
            id="salon-devise"
            label={t('create.currency')}
            error={fieldError('defaultCurrency')}
            {...register('defaultCurrency')}
          >
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </Select>
        </div>
        <Select
          id="salon-langue"
          label={t('create.language')}
          hint={t('create.languageHint')}
          error={fieldError('defaultLocale')}
          {...register('defaultLocale')}
        >
          {SUPPORTED_LOCALES.map((supported) => (
            <option key={supported} value={supported} lang={supported}>
              {languages(`names.${supported}` as 'names.en')}
            </option>
          ))}
        </Select>
      </fieldset>

      <fieldset className="spa-admin__section spa-platform-form__group">
        <legend className="spa-admin__section-title">{t('create.ownerLegend')}</legend>
        <p className="spa-admin-toolbar__hint">{t('create.ownerHint')}</p>
        <div className="spa-platform-form__row">
          <Field
            id="gerant-prenom"
            label={t('create.firstName')}
            autoComplete="off"
            required
            error={fieldError('adminFirstName')}
            {...register('adminFirstName')}
          />
          <Field
            id="gerant-nom"
            label={t('create.lastName')}
            autoComplete="off"
            required
            error={fieldError('adminLastName')}
            {...register('adminLastName')}
          />
        </div>
        <Field
          id="gerant-email"
          label={t('create.email')}
          type="email"
          autoComplete="off"
          required
          error={fieldError('adminEmail')}
          {...register('adminEmail')}
        />
      </fieldset>

      <div className="spa-admin-toolbar">
        <span className="spa-admin-toolbar__spacer" />
        <div className="spa-admin-toolbar__group">
          <Link className="spa-button spa-button--neutral" href={PLATFORM_TENANTS_PATH}>
            {t('create.cancel')}
          </Link>
          <Button
            type="submit"
            variant="accent"
            loading={isSubmitting}
            loadingLabel={t('create.submitting')}
          >
            {t('create.submit')}
          </Button>
        </div>
      </div>
    </form>
  );
}
