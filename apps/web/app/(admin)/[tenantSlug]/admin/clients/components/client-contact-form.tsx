'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  NAME_MAX_LENGTH,
  e164PhoneSchema,
  zodErrorMap,
  type Customer,
  type Locale,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { PhoneField } from '@/components/ui/phone-field';
import { useLocalizedFieldErrors } from '@/lib/field-refusal';
import { refusalMessage, type Refusal } from '@/lib/refusal';

import { updateCustomerAction } from '../actions';
import { useAdminSessionRenewal } from '../../components/use-admin-session-renewal';

/**
 * Correction des coordonnées d'une fiche — deuxième critère de #54.
 *
 * ## Replié par défaut
 *
 * La fiche s'ouvre pour être **lue** : le comptoir a la cliente au bout du fil
 * et cherche un numéro, pas un formulaire. L'édition est donc derrière un
 * bouton, comme sur la maquette — et le formulaire n'existe pas dans le DOM tant
 * qu'on ne l'a pas demandé, ce qui évite qu'une frappe distraite modifie la
 * fiche qu'on regardait.
 *
 * ## L'adresse est affichée, jamais modifiable
 *
 * Elle est la clé de `@@unique([tenantId, email])` et l'identifiant de
 * connexion : la changer demande de vérifier la nouvelle, ce que le périmètre
 * MVP ne prévoit pas. `updateCustomerRequestSchema` ne la porte pas et l'API
 * refuse en 400 le corps qui l'y glisserait — ce champ est donc en lecture
 * seule, avec la raison écrite à côté plutôt qu'une absence inexpliquée. Même
 * arbitrage que les coordonnées de l'espace client.
 *
 * De même pour l'activation : désactiver une fiche est une décision **sur** le
 * fichier et non une correction **dedans**, elle a sa propre route au rang
 * `manager`, et aucun critère de ce ticket ne la demande.
 *
 * ## Le téléphone, depuis #825
 *
 * Saisi derrière un drapeau — celui du salon par défaut, un autre si la
 * cliente dicte un numéro étranger — et émis en E.164, que `e164PhoneSchema`
 * valide sur place. La fiche est ce que la recherche par numéro et le rappel
 * par SMS relisent : un numéro qui n'est pas attribuable est refusé ici, sur
 * son champ, plutôt qu'au moment de l'envoi.
 *
 * ## Les refus de saisie suivent la langue eux aussi — #852
 *
 * Les libellés viennent du catalogue `admin-clients` ; les **bornes du contrat**
 * — « au moins 2 caractères », « numéro de téléphone invalide » — viennent de
 * `zodErrorMap(locale)` de `@spa/shared`. Sans lui, un formulaire anglais
 * afficherait ses refus en français : `nameSchema` et `e164PhoneSchema` sont
 * écrits une fois, au contrat, et c'est la table de messages de zod qui en dit
 * les bornes dans la langue de qui saisit.
 */

/** La phrase que ce formulaire écrit lui-même, dans la langue de l'écran. */
interface ContactFormMessages {
  readonly tooLong: string;
}

/**
 * Le schéma du formulaire — **les bornes du contrat, le plafond dit au catalogue**.
 *
 * Il n'emploie pas `nameSchema` directement, et c'est le même arbitrage que
 * `ServiceForm` (#849) : `zodErrorMap` ne traduit pas les messages qu'un schéma
 * écrit lui-même, et ceux de `nameSchema` sont des littéraux français.
 *
 * Ce qui ne change pas : la **règle** reste celle du contrat. Le plancher est le
 * même — un caractère après découpe des blancs —, et le plafond est
 * `NAME_MAX_LENGTH`, lu et non recopié.
 *
 * ## Le champ vide redit la phrase du contrat — #1373
 *
 * Le plancher portait « Ce champ est obligatoire. », prise au catalogue
 * `admin-clients`, mot pour mot identique à `validationPhrases(locale).required`
 * sans que rien ne relie les deux. Ce n'était pas une phrase de `nameSchema` —
 * c'est la phrase **générique** que `zodErrorMap` rend sur un `too_small` de
 * plancher 1, traduite dans les deux langues. Le `.min(1)` n'a donc plus de
 * message, et une seule source en décide. Le plafond garde le sien : sa
 * formulation n'est pas celle du contrat (« Ce champ fait au plus … » contre
 * « Ne dépassez pas … »), il n'y a là aucune copie à empêcher.
 */
function contactFormSchema(messages: ContactFormMessages) {
  const name = z
    .string()
    .trim()
    .min(1)
    .max(NAME_MAX_LENGTH, { message: messages.tooLong });

  return z.object({
    firstName: name,
    lastName: name,
    // Le refus du numéro n'est pas une phrase mais un drapeau : `PhoneField`
    // nomme lui-même le pays choisi (« … pour ce pays (Canada, +1) »), dans sa
    // langue. Le message de `e164PhoneSchema` n'est donc jamais affiché.
    phone: z.union([z.literal(''), e164PhoneSchema]),
  });
}

type ContactFormValues = z.input<ReturnType<typeof contactFormSchema>>;

interface ClientContactFormProps {
  readonly tenantSlug: string;
  readonly customer: Customer;
}

export function ClientContactForm({ tenantSlug, customer }: ClientContactFormProps) {
  const t = useTranslations('admin-clients.contact');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  /** Le **code** du refus, pas sa phrase (#1354) — voir `lib/refusal.ts`. */
  const [failure, setFailure] = useState<Refusal | null>(null);

  // Mémoïsé sur la langue, comme les formulaires de connexion et de réglages :
  // un résolveur neuf à chaque frappe serait reconstruit par `react-hook-form`
  // sans rien changer. `path` et `async` ne sont là que pour le **typage** de
  // `@hookform/resolvers`, qui déclare `ParseParams` entier là où zod n'en lit
  // qu'une partie.
  const tooLong = t('errors.tooLong', { max: NAME_MAX_LENGTH });
  const resolver = useMemo(
    () =>
      zodResolver(contactFormSchema({ tooLong }), {
        errorMap: zodErrorMap(locale),
        path: [],
        async: true,
      }),
    [locale, tooLong],
  );

  const {
    register,
    control,
    handleSubmit,
    setError,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormValues, unknown, z.output<ReturnType<typeof contactFormSchema>>>({
    resolver,
    defaultValues: {
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone ?? '',
    },
    mode: 'onTouched',
  });

  /**
   * Et les messages **des champs** suivent la langue — #1354.
   *
   * Le résolveur est refabriqué à la bascule, mais rien ne rejouait la
   * validation d'un nom déjà refusé : « ce champ est obligatoire » restait en
   * français sous une fiche passée en anglais. Le rejeu ne touche que les champs
   * **déjà fautifs** — corriger un prénom ne fait pas surgir un reproche sur le
   * nom. Aucun `own` : l'API ne refuse rien sur un champ ici, ses refus vont au
   * bandeau du formulaire.
   */
  useLocalizedFieldErrors({ locale, errors, trigger, setError });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    setSaved(false);

    const result = await updateCustomerAction(tenantSlug, customer.id, {
      firstName: values.firstName,
      lastName: values.lastName,
      // `null` efface le numéro ; la chaîne vide n'est pas une valeur du contrat.
      phone: values.phone === '' ? null : values.phone,
    });

    if (!result.ok) {
      if (renewIfExpired(result)) {
        return;
      }
      // Le `code`, jamais le `message` (#1354) : celui de l'API est écrit pour un
      // journal, dans une langue qui n'est pas négociée, et il restait en état —
      // donc figé — tant que le formulaire n'était pas démonté. C'est
      // `refusalMessage` qui écrit la phrase au rendu, depuis le contrat partagé.
      setFailure({ code: result.code });
      return;
    }

    setSaved(true);
    setOpen(false);
    // Le nom et le numéro sont rendus côté serveur, dans l'en-tête de la fiche
    // et dans la liste de gauche : sans ce rafraîchissement, les deux
    // resteraient ceux d'avant.
    router.refresh();
  });

  if (!open) {
    return (
      <>
        {saved ? (
          <Notification tone="success" title={t('savedTitle')}>
            <p>{t('savedBody')}</p>
          </Notification>
        ) : null}
        <Button
          variant="neutral"
          onClick={() => {
            setSaved(false);
            setOpen(true);
          }}
        >
          {t('edit')}
        </Button>
      </>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      {failure === null ? null : (
        <Notification tone="danger" title={t('failureTitle')}>
          {/* La phrase est écrite ici, dans la langue de ce rendu (#1354). */}
          <p>{refusalMessage(failure, locale)}</p>
        </Notification>
      )}

      <Field
        id={`client-first-name-${customer.id}`}
        label={t('firstName')}
        autoComplete="off"
        required
        error={errors.firstName?.message}
        {...register('firstName')}
      />
      <Field
        id={`client-last-name-${customer.id}`}
        label={t('lastName')}
        autoComplete="off"
        required
        error={errors.lastName?.message}
        {...register('lastName')}
      />
      <Controller
        control={control}
        name="phone"
        render={({ field, fieldState }) => (
          <PhoneField
            id={`client-phone-${customer.id}`}
            label={t('phone')}
            autoComplete="off"
            hint={t('phoneHint')}
            /*
             * Plus de propriété `locale` (#1267) : `PhoneField` lit lui-même la
             * langue de la session. #852 la passait ici parce que le champ
             * retombait sinon sur `'fr'` — le repli transitoire de #845, qui
             * annonçait « Pays de l'indicatif : États-Unis (+1) » au milieu d'un
             * formulaire anglais. Ce repli n'existe plus, et les sept écrans qui
             * montent ce champ en profitent, non plus le seul qui y pensait.
             */
            invalid={fieldState.invalid}
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            ref={field.ref}
          />
        )}
      />
      <Field
        id={`client-email-${customer.id}`}
        label={t('email')}
        type="email"
        value={customer.email}
        readOnly
        hint={t('emailHint')}
      />

      <Button type="submit" variant="accent" loading={isSubmitting} loadingLabel={t('saving')}>
        {t('save')}
      </Button>
      <Button
        variant="quiet"
        onClick={() => {
          setOpen(false);
        }}
      >
        {t('cancel')}
      </Button>
    </form>
  );
}
