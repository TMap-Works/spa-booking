'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  SUBSCRIPTION_PLAN,
  resourceSlugSchema,
  salonSignupRequestSchema,
  type Locale,
  type SalonSignupRequest,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { SUPPORTED_LOCALES } from '@/i18n/resolve';
import type { DisplayLocale } from '@/lib/format';
import { planPriceLabel } from '@/lib/plan';
import {
  CURRENCY_CHOICES,
  DEFAULT_COUNTRY,
  countryChoices,
  countryPreset,
  slugifySalonName,
  timezoneChoices,
} from '@/lib/salon-presets';

import { signupSalonAction } from '../actions';

/**
 * L'inscription d'un salon — ADR 0016.
 *
 * Deux groupes : le salon, puis son gérant. La soumission crée le salon et part
 * aussitôt vers la page de paiement Stripe, où la carte est enregistrée pour
 * l'essai gratuit — aucune donnée de carte ne passe par ce formulaire
 * (payments-stripe §1).
 *
 * La confirmation du mot de passe n'existe que côté écran : l'API ne reçoit que
 * le mot de passe (`salonSignupRequestSchema`).
 *
 * ## La langue (#1105)
 *
 * Trois choses en dépendent, et elles ne se confondent pas :
 *
 * - les **libellés**, qui viennent du namespace `signup` ;
 * - le **nom des pays**, rendu par `Intl.DisplayNames` (`lib/salon-presets.ts`)
 *   plutôt que par les libellés français figés des préréglages ;
 * - la **langue du salon créé** (`defaultLocale`, #844), qui est une donnée du
 *   formulaire et non celle de la visiteuse : une gérante peut très bien ouvrir
 *   en français un salon dont la vitrine s'annoncera en anglais. D'où un champ,
 *   et `en` présélectionné — le défaut du système, celui que l'API poserait de
 *   toute façon si le champ était absent.
 *
 * ## Les messages de validation, et pourquoi ils ne viennent pas du contrat
 *
 * Les schémas de `@spa/shared` portent leurs messages **en dur, en français**
 * (« adresse requise », « ville requise ») quand ils en portent un, et le
 * message anglais brut de Zod sinon (« String must contain at least 1
 * character(s) »). Un écran anglais devenait donc bilingue à la première
 * soumission — c'est ce que la recette de ce ticket a montré.
 *
 * Ils ne peuvent pas se traduire là où ils sont écrits : `packages/shared` est
 * lu par l'API autant que par le front, et n'a pas de langue de requête. Un
 * `errorMap` de Zod ne les rattraperait pas davantage — un message explicite
 * l'emporte sur lui.
 *
 * L'écran traduit donc **par champ**, dans son propre catalogue : la règle reste
 * celle du contrat, seule sa formulation change. Un message par champ et non par
 * code d'erreur, parce que c'est ce qu'une gérante lit — « indiquez votre
 * ville », et non « chaîne trop courte ».
 *
 * Les refus que l'**API** pose sur un champ (`setError`) échappent à cette
 * table : ils portent le type {@link SERVER_FIELD_ERROR}, et leur message —
 * déjà traduit par {@link ERROR_KEYS} — l'emporte.
 */

/**
 * La forme du formulaire, sans son message : il dépend de la langue, et la règle
 * n'en dépend pas. Le type se lit donc ici, le message est posé au rendu.
 */
const signupFormShape = salonSignupRequestSchema.extend({ confirmation: z.string() });

type SignupFormValues = z.input<typeof signupFormShape>;
type SignupFormOutput = z.output<typeof signupFormShape>;

/**
 * La langue du salon présélectionnée — `en`, le défaut du système (#844).
 *
 * La clientèle du produit est nord-américaine (décision du PO du 2026-09-19) :
 * le défaut suit le cas le plus fréquent, et non la langue de la visiteuse, qui
 * n'est pas la même question.
 */
const DEFAULT_SALON_LOCALE: Locale = 'en';

const EMPTY_VALUES: SignupFormValues = {
  name: '',
  slug: '',
  addressLine1: '',
  addressLine2: '',
  postalCode: '',
  city: '',
  countryCode: DEFAULT_COUNTRY.code,
  timezone: DEFAULT_COUNTRY.timezones[0],
  defaultCurrency: DEFAULT_COUNTRY.currency,
  defaultLocale: DEFAULT_SALON_LOCALE,
  adminFirstName: '',
  adminLastName: '',
  adminEmail: '',
  password: '',
  confirmation: '',
  dataConsent: false as unknown as true,
};

/**
 * Le type dont l'écran marque un refus venu de l'**API**.
 *
 * Il le distingue d'un refus de schéma, dont le type est le code d'erreur de
 * Zod : le premier porte déjà son message traduit, le second se traduit par
 * {@link FIELD_ERROR_KEYS}.
 */
const SERVER_FIELD_ERROR = 'server';

/** Ce qu'un champ refusé annonce, dans la langue lue — un message par champ. */
const FIELD_ERROR_KEYS = {
  name: 'fieldErrors.name',
  slug: 'fieldErrors.slug',
  addressLine1: 'fieldErrors.addressLine1',
  postalCode: 'fieldErrors.postalCode',
  city: 'fieldErrors.city',
  countryCode: 'fieldErrors.countryCode',
  timezone: 'fieldErrors.timezone',
  defaultCurrency: 'fieldErrors.defaultCurrency',
  defaultLocale: 'fieldErrors.defaultLocale',
  adminFirstName: 'fieldErrors.firstName',
  adminLastName: 'fieldErrors.lastName',
  adminEmail: 'fieldErrors.email',
  password: 'fieldErrors.password',
} as const;

type SignupFieldName = keyof typeof FIELD_ERROR_KEYS;

/**
 * Le type dont Zod marque un `refine`.
 *
 * Un message par champ suffit partout ailleurs, parce que les autres champs
 * n'ont qu'une manière d'être refusés. Le slug en a deux — sa **forme** et sa
 * **disponibilité** —, et les confondre donnerait à une gérante qui saisit
 * `support` un message qui lui demande des minuscules et des tirets — qu'elle a
 * déjà écrits.
 *
 * Ce type ne suffit plus à les séparer depuis #1232 : les deux règles de
 * `slugSchema` sont maintenant des `refine` — c'est ce qui leur permet de porter
 * une clé de message traduisible —, et rendent donc toutes deux un `custom`.
 * C'est {@link slugReserved} qui tranche, en rejouant la seule règle qui les
 * sépare.
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

/** Les clés d'erreur du catalogue, telles que `t()` les accepte. */
type ErrorKey =
  | 'errors.slugTaken'
  | 'errors.emailTaken'
  | 'errors.invalidLink'
  | 'errors.validation'
  | 'errors.tooManyRequests'
  | 'errors.unavailable'
  | 'errors.unexpected';

/**
 * Ce que chaque refus de l'API devient à l'écran, dans la langue lue.
 *
 * Le front réagit sur le **code**, jamais sur le message (web-frontend §2) : le
 * message que porte le refus est écrit côté serveur, donc en français, et
 * l'afficher tel quel rendrait un écran anglais bilingue à la première erreur.
 * Il ne sert plus que de repli, pour un code que cette table ne connaît pas.
 */
const ERROR_KEYS: Readonly<Record<string, ErrorKey>> = {
  [ERROR_CODES.TENANT_SLUG_TAKEN]: 'errors.slugTaken',
  [ERROR_CODES.EMAIL_ALREADY_REGISTERED]: 'errors.emailTaken',
  // Un lien d'activation ou de réinitialisation périmé — les deux se lisent
  // « ce lien n'est plus valable », et ni l'un ni l'autre ne dit pourquoi.
  [ERROR_CODES.INVALID_INVITATION]: 'errors.invalidLink',
  [ERROR_CODES.INVALID_PASSWORD_RESET_TOKEN]: 'errors.invalidLink',
  [ERROR_CODES.VALIDATION_ERROR]: 'errors.validation',
  [ERROR_CODES.BAD_REQUEST]: 'errors.validation',
  [ERROR_CODES.BUSINESS_RULE_VIOLATION]: 'errors.validation',
  [ERROR_CODES.TOO_MANY_REQUESTS]: 'errors.tooManyRequests',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'errors.unavailable',
  [ERROR_CODES.INTERNAL_ERROR]: 'errors.unexpected',
};

export function SignupForm() {
  const t = useTranslations('signup');
  // Les noms de langues sont ceux du sélecteur de la coquille : « Français » et
  // « English », chacun dans la sienne, identiques dans les deux catalogues
  // (#845). Les redire ici en aurait fait une seconde écriture.
  const languages = useTranslations('locale');
  const locale = useLocale() as Locale;
  const [slugTouched, setSlugTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  // Aucun établissement n'existe encore : la région de mise en forme est celle
  // du repli de `lib/format.ts`, comme sur la page qui porte ce formulaire.
  const display: DisplayLocale = { locale, countryCode: null };
  const promise = t('plan.promise', {
    days: SUBSCRIPTION_PLAN.trialDays,
    price: planPriceLabel(display),
  });

  const schema = useMemo(
    () =>
      signupFormShape.refine((values) => values.password === values.confirmation, {
        message: t('form.confirmationMismatch'),
        path: ['confirmation'],
      }),
    [t],
  );

  const countries = useMemo(() => countryChoices(locale), [locale]);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormValues, unknown, SignupFormOutput>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY_VALUES,
    mode: 'onTouched',
  });

  /**
   * Ce qu'affiche un champ refusé — rien s'il ne l'est pas.
   *
   * Un refus de l'API garde son propre message ; un refus de schéma prend celui
   * du catalogue. Voir l'en-tête de ce module.
   */
  const fieldError = (name: SignupFieldName): string | undefined => {
    const error = errors[name];

    if (error === undefined) {
      return undefined;
    }

    if (error.type === SERVER_FIELD_ERROR) {
      return error.message;
    }

    // Le nom réservé — voir {@link CUSTOM_FIELD_ERROR}. Une faute de forme rend
    // le même code depuis #1232 : c'est la valeur saisie qui les départage.
    if (name === 'slug' && error.type === CUSTOM_FIELD_ERROR && slugReserved(watch('slug'))) {
      return t('fieldErrors.slugReserved');
    }

    return t(FIELD_ERROR_KEYS[name]);
  };

  const submit = handleSubmit(async ({ confirmation: _confirmation, ...values }) => {
    setFailure(null);
    const request: SalonSignupRequest = values;
    const result = await signupSalonAction(request);

    if (!result.ok) {
      const key = ERROR_KEYS[result.code];

      // Un refus qui désigne un champ s'affiche **sur** ce champ, jamais en bloc
      // en haut de page (web-frontend §4).
      if (result.code === ERROR_CODES.TENANT_SLUG_TAKEN) {
        setError('slug', { type: SERVER_FIELD_ERROR, message: t('errors.slugTaken') });
        return;
      }
      if (result.code === ERROR_CODES.EMAIL_ALREADY_REGISTERED) {
        setError('adminEmail', { type: SERVER_FIELD_ERROR, message: t('errors.emailTaken') });
        return;
      }

      setFailure(key === undefined ? result.message : t(key));
      return;
    }

    // Vers Stripe, ou l'écran d'abonnement : on quitte la page pour de bon.
    setLeaving(true);
    window.location.assign(result.data.next);
  });

  const nameField = register('name');
  const slugField = register('slug');
  const countryField = register('countryCode');
  // Les fuseaux proposés suivent le pays choisi : un salon de Chicago n'a que
  // faire de `Indian/Reunion` (#1103).
  const timezones = timezoneChoices(watch('countryCode'));

  return (
    <form
      className="spa-admin__section spa-admin-form spa-signup-form"
      aria-labelledby="inscription-titre"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h1 className="spa-admin__section-title" id="inscription-titre">
        {t('form.title')}
      </h1>

      {failure === null ? null : (
        <Notification tone="danger" title={t('errors.title')}>
          <p>{failure}</p>
        </Notification>
      )}

      <fieldset className="spa-signup-form__group">
        <legend className="spa-signup-form__legend">{t('form.salonLegend')}</legend>
        <Field
          id="inscription-nom"
          label={t('form.name')}
          autoComplete="organization"
          required
          error={fieldError('name')}
          {...nameField}
          onChange={(event) => {
            void nameField.onChange(event);
            if (!slugTouched) {
              setValue('slug', slugifySalonName(event.target.value));
            }
          }}
        />
        <Field
          id="inscription-adresse-web"
          label={t('form.slug')}
          hint={t('form.slugHint')}
          required
          error={fieldError('slug')}
          {...slugField}
          onChange={(event) => {
            setSlugTouched(true);
            void slugField.onChange(event);
          }}
        />
        <Field
          id="inscription-adresse"
          label={t('form.addressLine1')}
          autoComplete="address-line1"
          required
          error={fieldError('addressLine1')}
          {...register('addressLine1')}
        />
        <div className="spa-platform-form__row">
          <Field
            id="inscription-code-postal"
            label={t('form.postalCode')}
            autoComplete="postal-code"
            error={fieldError('postalCode')}
            {...register('postalCode')}
          />
          <Field
            id="inscription-ville"
            label={t('form.city')}
            autoComplete="address-level2"
            required
            error={fieldError('city')}
            {...register('city')}
          />
        </div>
        <div className="spa-platform-form__row">
          <Select
            id="inscription-pays"
            label={t('form.country')}
            error={fieldError('countryCode')}
            {...countryField}
            onChange={(event) => {
              void countryField.onChange(event);
              const preset = countryPreset(event.target.value);
              if (preset !== undefined) {
                setValue('timezone', preset.timezones[0]);
                setValue('defaultCurrency', preset.currency);
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
            id="inscription-fuseau"
            label={t('form.timezone')}
            error={fieldError('timezone')}
            {...register('timezone')}
          >
            {timezones.map((timezone) => (
              <option key={timezone} value={timezone}>
                {timezone}
              </option>
            ))}
          </Select>
          <Select
            id="inscription-devise"
            label={t('form.currency')}
            error={fieldError('defaultCurrency')}
            {...register('defaultCurrency')}
          >
            {CURRENCY_CHOICES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </Select>
        </div>
        <Select
          id="inscription-langue"
          label={t('form.language')}
          hint={t('form.languageHint')}
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

      <fieldset className="spa-signup-form__group">
        <legend className="spa-signup-form__legend">{t('form.ownerLegend')}</legend>
        <div className="spa-platform-form__row">
          <Field
            id="inscription-prenom"
            label={t('form.firstName')}
            autoComplete="given-name"
            required
            error={fieldError('adminFirstName')}
            {...register('adminFirstName')}
          />
          <Field
            id="inscription-nom-gerant"
            label={t('form.lastName')}
            autoComplete="family-name"
            required
            error={fieldError('adminLastName')}
            {...register('adminLastName')}
          />
        </div>
        <Field
          id="inscription-email"
          label={t('form.email')}
          type="email"
          autoComplete="email"
          required
          error={fieldError('adminEmail')}
          {...register('adminEmail')}
        />
        <Field
          id="inscription-mot-de-passe"
          label={t('form.password')}
          hint={t('form.passwordHint')}
          type="password"
          autoComplete="new-password"
          required
          error={fieldError('password')}
          {...register('password')}
        />
        <Field
          id="inscription-confirmation"
          label={t('form.confirmation')}
          type="password"
          autoComplete="new-password"
          required
          error={errors.confirmation?.message}
          {...register('confirmation')}
        />
      </fieldset>

      <div className="spa-consent__choice">
        <input
          {...register('dataConsent')}
          type="checkbox"
          id="inscription-consentement"
          className="spa-consent__control"
          aria-invalid={errors.dataConsent === undefined ? undefined : true}
          aria-describedby={
            errors.dataConsent === undefined ? undefined : 'inscription-consentement-error'
          }
        />
        <label className="spa-consent__label" htmlFor="inscription-consentement">
          {t('form.consent')}
        </label>
      </div>
      {errors.dataConsent === undefined ? null : (
        <p id="inscription-consentement-error" className="spa-consent__error" role="alert">
          {t('form.consentRequired')}
        </p>
      )}

      <Button
        type="submit"
        variant="accent"
        block
        loading={isSubmitting || leaving}
        loadingLabel={t('form.submitting')}
      >
        {t('form.submit')}
      </Button>
      <p className="spa-signup-form__fineprint">{t('form.fineprint', { promise })}</p>
    </form>
  );
}
