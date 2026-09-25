'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  e164PhoneSchema,
  ERROR_CODES,
  PASSWORD_MIN_LENGTH,
  registerRequestSchema,
  zodErrorMap,
  type Locale,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { PasswordField } from '@/components/ui/password-field';
import { PhoneField } from '@/components/ui/phone-field';
import { ACCOUNT_CONSENT, ConsentField, consentSchema } from '@/lib/booking/consent';

import { registerAction } from '../actions';
import { RETURN_QUERY_KEY, safeReturnPath, withReturnPath } from '../connexion/return-path';
import { accountPath } from '../paths';

/**
 * Inscription cliente (#47, premier critère).
 *
 * Le schéma **dérive** du contrat, il ne le réécrit pas : `registerRequestSchema`
 * porte déjà la politique de mot de passe et les bornes de longueur, et les
 * recopier ici les ferait diverger au premier durcissement.
 *
 * La seule extension est celle qu'impose un formulaire HTML : un champ vide vaut
 * `''`, pas `undefined`. `phone` étant facultatif au contrat, l'union avec la
 * chaîne vide est ce qui évite un message d'erreur sur un champ qu'on a le droit
 * de ne pas remplir — et le `transform` la ramène à l'absence avant l'envoi.
 * Même conduite que le formulaire de coordonnées du tunnel.
 *
 * La seconde extension est le **consentement** (#734, CDC §5.1). Il appartient
 * désormais au contrat — `registerRequestSchema.dataConsent`, obligatoire et
 * refusé à `false` depuis #880 —, et ce que le formulaire en fait ici tient en
 * un mot : il **substitue le message**. Le refus du contrat s'adresse à un
 * appelant d'API (« le traitement des données doit être accepté pour créer un
 * compte ») ; celui de `consentSchema` s'adresse à la cliente, sur sa case, et
 * il est le même que dans l'étape « Coordonnées » du tunnel — une cliente passe
 * de l'un à l'autre sans changer de produit (`lib/booking/consent.tsx`).
 *
 * Le champ garde donc le nom du contrat, `dataConsent`, et non plus `consent` :
 * c'est lui qui part dans le corps de l'inscription, et le renommer à la
 * soumission aurait rendu la correspondance invisible.
 *
 * Le téléphone est validé par `e164PhoneSchema` depuis #825 : `PhoneField` émet
 * toujours un numéro international, que le pays de l'établissement n'a donc
 * plus à compléter — c'est la même règle que l'API applique
 * (`e164PhoneSchemaFor`), à ceci près qu'elle n'a plus rien à deviner.
 */
const registerFormSchema = registerRequestSchema.extend({
  phone: z.union([z.literal(''), e164PhoneSchema]),
  dataConsent: consentSchema,
});

type RegisterFormValues = z.input<typeof registerFormSchema>;

/**
 * Le critère de longueur est dit au présent et coché en direct (#1052).
 *
 * L'audit `d20260918-1` relève qu'« aucun bouton pour afficher le mot de passe »
 * et qu'on n'apprend la longueur exigée qu'en échouant. La phrase est portée par
 * le `hint` de `PasswordField`, donc par l'`aria-describedby` du champ : un
 * lecteur d'écran l'annonce en y arrivant, et la relit quand elle change. Un
 * texte posé à côté du champ ne l'aurait pas été.
 *
 * La longueur vient du contrat (`PASSWORD_MIN_LENGTH`) et n'est pas recopiée :
 * la relever un jour ne doit pas laisser cet écran promettre l'ancienne. Elle est
 * donc un **paramètre du message** (`{min}`) depuis #847, et non une
 * concaténation : « 8 characters minimum. » ne place pas le nombre où le
 * français le met.
 */

interface RegisterFormProps {
  readonly tenantSlug: string;
}

export function RegisterForm({ tenantSlug }: RegisterFormProps) {
  const t = useTranslations('account.register');
  const locale = useLocale() as Locale;
  const router = useRouter();
  /*
   * Le retour reçu du lien « Créer mon compte » de la connexion, rejugé ici
   * comme il l'a été là-bas (#1087) : cet écran est atteignable directement, et
   * un paramètre revalidé en amont ne prouve rien sur celui qui arrive ici.
   * Voir `connexion/return-path.ts`.
   */
  const returnTo = safeReturnPath(useSearchParams().get(RETURN_QUERY_KEY), tenantSlug);
  const [failure, setFailure] = useState<string | null>(null);
  /*
   * Les bornes du contrat — longueur du mot de passe, adresse e-mail, numéro
   * incomplet — sont dites par `zodErrorMap(locale)` depuis #1232 : elles
   * venaient jusqu'ici de phrases françaises écrites dans les schémas partagés,
   * qui s'affichaient telles quelles sous cet écran en anglais. Le consentement,
   * lui, garde le message de `consentSchema` : il s'adresse à la cliente, pas à
   * un appelant d'API (voir l'en-tête de ce module).
   */
  const resolver = useMemo(
    () => zodResolver(registerFormSchema, { errorMap: zodErrorMap(locale), path: [], async: true }),
    [locale],
  );

  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues, unknown, z.output<typeof registerFormSchema>>({
    resolver,
    // La case part décochée, et il n'y a pas d'autre valeur possible : un
    // consentement pré-coché n'est pas un consentement (#734).
    defaultValues: {
      email: '',
      password: '',
      firstName: '',
      lastName: '',
      phone: '',
      dataConsent: false,
    },
    // Validation à la **soumission**, puis à chaque frappe — et non au `blur`
    // de chaque champ. Ce n'est pas une préférence de style : `onTouched`
    // faisait perdre la première soumission (#698).
    //
    // Le formulaire compte cinq champs et aucun n'est pré-rempli, si bien qu'au
    // moment où l'on clique sur « Créer mon compte » le dernier champ saisi est
    // encore celui qui a le focus. Le `mousedown` du bouton le fait perdre, le
    // `blur` déclenche la validation de ce champ, et son message s'insère
    // **dans le flux** sous le contrôle : le bouton descend de 25 px, le
    // `mouseup` retombe à côté, et le navigateur n'émet aucun `click` — donc
    // aucun `submit`. Ce que voit la cliente, ce sont les seules erreurs de
    // `blur`, celles des champs qu'elle a traversés ; « Nom », laissé vide et
    // jamais visité, n'en fait pas partie. Il faut un second clic — sur une
    // mise en page cette fois stabilisée — pour que la soumission ait lieu et
    // le signale enfin.
    //
    // `onSubmit` supprime la cause plutôt que le symptôme : aucun message ne
    // peut plus s'insérer entre le `mousedown` et le `mouseup`, la première
    // soumission aboutit, et elle rend d'un coup **tous** les champs fautifs,
    // sur leurs champs. `reValidateMode` rend ensuite la correction vivante —
    // chaque erreur disparaît à la frappe, sans attendre une soumission de plus.
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  // `watch` rend le critère vivant : il se coche à la frappe, sans attendre une
  // soumission ni la perte du focus.
  const passwordRuleMet = (watch('password') ?? '').length >= PASSWORD_MIN_LENGTH;

  const submit = handleSubmit(async (values) => {
    setFailure(null);

    const result = await registerAction(tenantSlug, {
      email: values.email,
      password: values.password,
      firstName: values.firstName,
      lastName: values.lastName,
      // Absent plutôt que vide : le contrat distingue les deux, et une chaîne
      // vide descendrait jusqu'à la colonne comme un numéro de zéro caractère.
      ...(values.phone === '' ? {} : { phone: values.phone }),
      // L'accord part avec l'inscription, et c'est le serveur qui le date
      // (#880) : aucune date n'est envoyée d'ici, le contrat la refuserait.
      dataConsent: values.dataConsent,
    });

    if (!result.ok) {
      /*
       * Le message du contrat dit « un compte existe déjà avec cette adresse » ;
       * celui-ci ajoute les deux choses que cet écran-là sait et que le contrat
       * ignore : l'unicité est bornée à **cet établissement**
       * (`@@unique([tenantId, email])`), et la suite à donner est de se
       * connecter. D'où une entrée en propre au catalogue plutôt que
       * `errorMessage` (#847).
       */
      setFailure(
        result.code === ERROR_CODES.EMAIL_ALREADY_REGISTERED
          ? t('emailAlreadyRegistered')
          : result.message,
      );
      return;
    }

    // Là d'où l'on vient quand l'adresse le dit, l'espace client sinon (#1087).
    router.replace(returnTo ?? accountPath(tenantSlug));
    router.refresh();
  });

  return (
    <section className="spa-account__panel" aria-labelledby="inscription-titre">
      <h2 className="spa-account__section-title" id="inscription-titre">
        {t('title')}
      </h2>

      {failure === null ? null : (
        <Notification tone="danger" title={t('failureTitle')}>
          <p>{failure}</p>
        </Notification>
      )}

      <form className="spa-account__form" onSubmit={(event) => void submit(event)} noValidate>
        {/*
          Prénom et nom côte à côte dès 30 rem (#1052) : deux champs courts, de
          même nature, remplis d'un même geste. Empilés, ils coûtaient 150 px
          d'un écran de téléphone où le bouton tombait déjà à 1 290 px. Sous le
          palier, la rangée retombe en colonne — deux champs de 90 px de large ne
          se remplissent pas.
        */}
        <div className="spa-account__form-row">
          <Field
            id="register-first-name"
            label={t('firstName')}
            autoComplete="given-name"
            required
            error={errors.firstName?.message}
            {...register('firstName')}
          />
          <Field
            id="register-last-name"
            label={t('lastName')}
            autoComplete="family-name"
            required
            error={errors.lastName?.message}
            {...register('lastName')}
          />
        </div>
        <Field
          id="register-email"
          label={t('email')}
          type="email"
          autoComplete="email"
          required
          hint={t('emailHint')}
          error={errors.email?.message}
          {...register('email')}
        />
        <Controller
          control={control}
          name="phone"
          render={({ field, fieldState }) => (
            <PhoneField
              id="register-phone"
              label={t('phone')}
              hint={t('phoneHint')}
              invalid={fieldState.invalid}
              value={field.value ?? ''}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={field.ref}
            />
          )}
        />
        {/*
          Le critère se coche à la frappe : `data-met` porte l'état, la feuille
          de style colore la phrase et pose la coche. La couleur ne porte jamais
          l'information seule — c'est le texte lui-même qui change (« … au
          minimum. » / « … : c'est bon. »), et c'est lui que le champ référence
          par `aria-describedby`.
        */}
        <div className="spa-account__password-rule" data-met={passwordRuleMet}>
          <PasswordField
            id="register-password"
            label={t('password')}
            autoComplete="new-password"
            required
            hint={
              passwordRuleMet
                ? t('passwordRuleMet', { min: PASSWORD_MIN_LENGTH })
                : t('passwordRulePending', { min: PASSWORD_MIN_LENGTH })
            }
            error={errors.password?.message}
            {...register('password')}
          />
        </div>

        {/* Même bloc, même texte de base et même règle que l'étape
            « Coordonnées » du tunnel : une cliente passe de l'un à l'autre sans
            changer de produit, et deux formulations de la même promesse se
            liraient comme deux sites (#734).

            Le message n'a pas à être conditionné ici comme il l'est là-bas : ce
            formulaire valide `onSubmit`, donc aucune erreur n'apparaît avant
            que la question ait été posée. */}
        <ConsentField
          id="register-consent"
          tenantSlug={tenantSlug}
          copy={ACCOUNT_CONSENT}
          error={errors.dataConsent?.message}
          {...register('dataConsent')}
        />

        <Button
          type="submit"
          variant="accent"
          block
          loading={isSubmitting}
          loadingLabel={t('submitting')}
        >
          {t('submit')}
        </Button>
      </form>

      <p className="spa-account__switch">
        {t('haveAccount')}{' '}
        {/* Le retour traverse le lien dans les deux sens (#1087). */}
        <Link href={withReturnPath(accountPath(tenantSlug, '/connexion'), returnTo)}>
          {t('signIn')}
        </Link>
      </p>
    </section>
  );
}
