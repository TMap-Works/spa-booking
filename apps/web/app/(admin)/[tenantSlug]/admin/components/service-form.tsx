'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  CATALOG_ERROR_CODES,
  DISPLAY_NAME_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  longTextSchema,
  resourceSlugSchema,
  slugSchema,
  zodErrorMap,
  type CreateServiceRequest,
  type Locale,
  type Service,
  type ServiceCategory,
  type UpdateServiceRequest,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { TextArea } from '@/components/ui/textarea';
import {
  formatAmountInput,
  formatDuration,
  parseAmountInput,
  reformatAmountInput,
  type DisplayLocale,
} from '@/lib/format';
import { useLocalizedFieldErrors } from '@/lib/field-refusal';
import { refusalMessage, type Refusal } from '@/lib/refusal';

import { adminServicePath } from '../paths';
import { createServiceAction, updateServiceAction } from '../catalogue/actions';
import { useAdminAnnouncement } from './admin-announcement';
import { useAdminSessionRenewal } from './use-admin-session-renewal';

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
 * ## Les deux issues s'annoncent, et la création par un détour (#1037)
 *
 * L'enregistrement d'une prestation existante a son bandeau ici même : l'écran
 * ne bouge pas, l'état local suffit. La **création**, elle, change d'écran — et
 * un état porté par ce composant serait démonté avec lui. Elle passe donc par le
 * fournisseur du layout (`admin-announcement.tsx`), qui porte une région
 * `aria-live` montée d'avance et délivre l'annonce sur la fiche d'arrivée, en la
 * **nommant** et en offrant « Affecter un praticien ». Un `?annonce=…` aurait
 * rejoué le succès à chaque F5 ; c'est le geste déjà écrit pour l'espace client
 * (#746), et l'issue l'écarte explicitement.
 *
 * ## Le prix ne passe jamais par un flottant
 *
 * La saisie est une chaîne (« 35,00 » en français, « 35.00 » en anglais),
 * convertie par `parseAmountInput` en entier de plus petite unité **par
 * concaténation de chiffres**, jamais par une multiplication. La devise est celle
 * de l'établissement, lue sur ses réglages : elle n'est pas saisissable ici,
 * parce qu'un salon vend dans une seule monnaie et qu'un choix par prestation ne
 * ferait qu'ouvrir la porte à un catalogue mélangé — donc à des totaux
 * impossibles à additionner.
 *
 * Le **séparateur décimal suit la langue de l'écran** (#1123) : la valeur
 * pré-remplie, le gabarit du champ et la phrase qui refuse une saisie hors devise
 * emploient tous les trois celui de la langue, et `parseAmountInput` relit ce que
 * `formatAmountInput` vient d'écrire. Il reste tolérant aux deux séparateurs —
 * une virgule tapée sur un écran anglais vaut un point.
 *
 * ## Ce que la durée bloquée montre, et pourquoi elle n'est pas saisissable
 *
 * `occupiedMinutes` est la somme de la durée et des deux tampons. L'API la
 * calcule et ne la stocke pas ; l'écran la recalcule pour l'afficher **pendant
 * la saisie**, parce que c'est la valeur qui décide de l'agenda et qu'une
 * gérante doit la voir avant d'enregistrer. Elle reste en lecture seule : un
 * quatrième champ divergerait de ses trois termes au premier enregistrement
 * partiel.
 *
 * ## Ce que le rang praticien en voit
 *
 * Tout, en lecture seule. `POST` et `PATCH /v1/services` sont
 * `@AuthAtLeast('MANAGER')` : laisser les champs vifs et le bouton actif, c'était
 * faire saisir neuf champs pour rendre « Droits insuffisants » (#619). Les champs
 * sont donc grisés et le bouton cède la place à la raison — c'est le geste déjà
 * écrit dans l'éditeur d'horaires du personnel, et il vaut mieux que la fiche
 * disparaisse : une praticienne a besoin de lire la durée et le prix de ce
 * qu'elle pratique.
 *
 * ## Les deux sources de refus sont dans la langue de l'écran (#849)
 *
 * - les messages **du schéma** ci-dessous, ceux que ce formulaire écrit
 *   lui-même, passés à sa fabrique depuis le catalogue `admin-catalog` ;
 * - ceux que **zod** écrit pour les bornes des schémas du contrat — « saisissez
 *   au moins 3 caractères » —, par `zodErrorMap` de `@spa/shared`. Sans lui, la
 *   description trop longue se refusait en anglais brut de zod sous un
 *   formulaire français, et l'inverse sous un formulaire anglais.
 *
 * ## Pourquoi le nom et l'adresse ne sont plus `displayNameSchema` ni `slugSchema`
 *
 * Parce que `zodErrorMap` ne traduit **pas** les messages qu'un schéma écrit
 * lui-même — c'est écrit noir sur blanc dans `zod-messages.ts`, et c'est voulu :
 * ces phrases-là nomment une valeur attendue du contrat, et leur place est
 * auprès du schéma qui la déclare. Elles sont en français littéral, si bien que
 * « ce champ est obligatoire » et « slug attendu en minuscules… » s'affichaient
 * tels quels sous un formulaire anglais — constat fait au navigateur, phase de
 * recette de #849.
 *
 * **La règle reste celle du contrat** : les bornes du nom sont les siennes
 * (`DISPLAY_NAME_MAX_LENGTH`), et l'adresse est validée par `slugSchema`
 * lui-même, appelé ici. Seule la **phrase** change de main. Traduire les
 * littéraux du contrat serait la vraie correction, mais elle vit dans
 * `packages/shared` et concerne tous les écrans déjà traduits : elle fait l'objet
 * d'un suivi, pas de ce ticket.
 *
 * ## Ce que #1373 reprend : le nom vide redit la phrase du contrat
 *
 * L'arbitrage ci-dessus valait pour les phrases qu'un **schéma du contrat écrit
 * lui-même** — celles de `slugSchema`, que zod court-circuite dès qu'une `issue`
 * porte un `message`. « Ce champ est obligatoire. » n'en est pas une : c'est la
 * phrase **générique** que `zodErrorMap` rend sur un `too_small` de plancher 1,
 * traduite dans les deux langues depuis #845. Ce formulaire en portait pourtant
 * une copie au catalogue, mot pour mot identique, et rien ne reliait les deux —
 * le jour où l'une bougeait, le même champ disait deux phrases.
 *
 * Le `.min(1)` ci-dessous ne porte donc plus de message : la carte passée au
 * résolveur sert la phrase, et `validationPhrases(locale).required` en décide
 * seule. C'est déjà ainsi que le reste du produit procède — `RegisterForm`,
 * `StaffMemberForm` (`validation-i18n.test.tsx`).
 *
 * Ce que la gérante **saisit**, en revanche, ne se traduit jamais : le nom, la
 * description et le nom des rubriques du `<select>` sont rendus tels qu'ils sont
 * enregistrés.
 */

/**
 * Les phrases que ce formulaire écrit lui-même, dans la langue de l'écran.
 *
 * Un objet et non six paramètres positionnels : la fabrique est appelée à un
 * seul endroit, et un message ajouté un jour n'obligera pas à relire l'ordre des
 * arguments.
 */
interface ServiceFormMessages {
  readonly nameTooLong: string;
  readonly slug: string;
  readonly slugReserved: string;
  readonly slugTooLong: string;
  readonly minutes: string;
  readonly positiveDuration: string;
  readonly amount: string;
}

/**
 * Pourquoi `slugSchema` a refusé cette adresse, dit dans la langue de l'écran.
 *
 * Une seule phrase pour les trois causes serait **fausse** dans deux cas sur
 * trois : « minuscules, chiffres et tirets simples » sous `www`, qui n'a rien
 * d'autre que des minuscules, ne dit pas à la gérante ce qu'elle doit corriger —
 * et c'est un nom réservé de la plateforme qu'elle vient de saisir. Le verdict
 * reste celui du contrat ; on ne fait que lire **quel** de ses contrôles a
 * échoué. La borne de longueur se lit sur le code `too_big` de zod ; le nom
 * réservé et la faute de forme rendent tous deux un `custom` depuis #1232, et se
 * départagent en rejouant `resourceSlugSchema` (voir ci-dessous).
 *
 * Même écriture dans `category-manager.tsx` : ce qui serait mis en commun n'est
 * pas la règle — elle est déjà partagée — mais un branchement de formulaire.
 */
function slugRefusal(
  value: string,
  messages: Pick<ServiceFormMessages, 'slug' | 'slugReserved' | 'slugTooLong'>,
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

/**
 * Le schéma de la **saisie**, construit autour de la devise du salon et des
 * phrases de sa langue.
 *
 * Il diffère des contrats de `@spa/shared` sur un point : la chaîne vide y est
 * licite là où un champ est facultatif, parce qu'un champ de formulaire vidé est
 * vide et non absent. La conversion se fait à l'envoi, et l'action serveur
 * revalide derrière avec le vrai contrat.
 */
function serviceFormSchema(
  currency: string,
  display: DisplayLocale,
  messages: ServiceFormMessages,
) {
  /** Chaîne d'entiers positifs — le contrôle le plus proche de la saisie réelle. */
  const digitsSchema = z.string().trim().regex(/^\d+$/, { message: messages.minutes });

  return z.object({
    // Les bornes de `displayNameSchema`, ses phrases en moins — voir l'en-tête.
    // Le plancher, lui, n'a **pas** de message : sans lui, c'est `zodErrorMap`
    // qui répond, et `validationPhrases(locale).required` décide seule de la
    // phrase du champ vide (#1373).
    name: z
      .string()
      .trim()
      .min(1)
      .max(DISPLAY_NAME_MAX_LENGTH, { message: messages.nameTooLong }),
    // Vide vaut « laisse le serveur dériver l'adresse du nom ». Sinon, c'est
    // `slugSchema` qui tranche — la règle reste celle du contrat, seule sa
    // phrase vient de l'écran. Le `trim`/`toLowerCase` est celui que
    // `slugSchema` applique : sans lui, une adresse saisie en capitales partirait
    // telle quelle vers l'API. Même écriture dans `category-manager.tsx`, à
    // cinq lignes près : ce qui y serait mis en commun n'est pas la règle —
    // elle est déjà partagée — mais un branchement de formulaire.
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
    categoryId: z.string(),
    durationMinutes: digitsSchema.refine((value) => Number(value) >= 1, {
      message: messages.positiveDuration,
    }),
    // Zéro est le cas courant — un soin sans temps de préparation — et le champ
    // vide vaut zéro. Négatif n'existe pas : un tampon négatif rendrait la
    // cabine disponible avant la fin réelle du soin.
    bufferBeforeMinutes: z.union([z.literal(''), digitsSchema]),
    bufferAfterMinutes: z.union([z.literal(''), digitsSchema]),
    price: z.string().refine((value) => parseAmountInput(value, currency, display) !== null, {
      message: messages.amount,
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
  /**
   * `false` au rang praticien : `POST` et `PATCH /v1/services` sont
   * `@AuthAtLeast('MANAGER')`. La fiche reste lisible — durée, tampons, prix,
   * rubrique — mais ses champs sont inertes et le bouton d'enregistrement cède
   * la place à la raison, sur le modèle de l'éditeur d'horaires du personnel
   * (#619).
   */
  readonly canManage?: boolean;
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

export function ServiceForm({
  tenantSlug,
  currency,
  categories,
  service,
  canManage = true,
}: ServiceFormProps) {
  const t = useTranslations('admin-catalog.form');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const announce = useAdminAnnouncement();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [saved, setSaved] = useState(false);
  /** Le **code** du refus, pas sa phrase (#1327) — voir `lib/refusal.ts`. */
  const [failure, setFailure] = useState<Refusal | null>(null);
  /**
   * Ce qui met en forme un montant sur cet écran — la langue de la session.
   *
   * Sans `countryCode` : ce formulaire ne reçoit pas le pays de l'établissement,
   * et le prix qu'il pré-remplit est le seul montant que cet écran affiche — la
   * liste du catalogue, qui est l'autre endroit où on le lit, s'en passe de même
   * (`catalogue/(liste)/page.tsx`). C'est `formatMoney` des écrans de caisse qui
   * en a besoin, pas la saisie d'un prix.
   *
   * Mémorisé parce qu'il entre dans les dépendances du résolveur juste en
   * dessous : un objet neuf à chaque rendu reconstruirait le schéma à chaque
   * frappe.
   */
  const display = useMemo<DisplayLocale>(() => ({ locale }), [locale]);
  /**
   * L'exemple de montant, une fois — il sert au gabarit du champ **et** à la
   * phrase qui refuse une saisie hors devise. Deux écritures finiraient par
   * diverger, et l'écran proposerait un séparateur pour en refuser un autre.
   *
   * La **valeur** pré-remplie suit désormais la même langue (#1123) :
   * `formatAmountInput` écrit « 35,00 » sous un formulaire français et « 35.00 »
   * sous un formulaire anglais, là où il figeait la virgule. Rien ne se perd de la
   * tolérance d'avant — `parseAmountInput` accepte toujours les deux séparateurs,
   * et rend le même entier de plus petite unité.
   */
  const priceExample = t('priceExample');
  const amountMessage = t('errors.amount', { example: priceExample });
  /*
   * `path` et `async` ne sont là que pour le **typage** de
   * `@hookform/resolvers`, qui déclare `ParseParams` entier là où zod n'en lit
   * qu'une partie : au runtime, `safeParseAsync` force `async: true` et retombe
   * sur `path: []`. Même écriture que `AdminLoginForm` et `TenantSettingsForm`.
   */
  const resolver = useMemo(
    () =>
      zodResolver(
        serviceFormSchema(currency, display, {
          nameTooLong: t('errors.nameTooLong', { max: DISPLAY_NAME_MAX_LENGTH }),
          slug: t('errors.slug'),
          slugReserved: t('errors.slugReserved'),
          slugTooLong: t('errors.slugTooLong', { max: SLUG_MAX_LENGTH }),
          minutes: t('errors.minutes'),
          positiveDuration: t('errors.positiveDuration'),
          amount: amountMessage,
        }),
        { errorMap: zodErrorMap(locale), path: [], async: true },
      ),
    [amountMessage, currency, display, locale, t],
  );

  const {
    register,
    handleSubmit,
    getValues,
    setError,
    setValue,
    trigger,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ServiceFormValues, unknown, z.output<ReturnType<typeof serviceFormSchema>>>({
    resolver,
    defaultValues: {
      name: service?.name ?? '',
      slug: service?.slug ?? '',
      description: service?.description ?? '',
      categoryId: service?.category?.id ?? '',
      durationMinutes: service === undefined ? '' : String(service.durationMinutes),
      bufferBeforeMinutes: service === undefined ? '' : String(service.bufferBeforeMinutes),
      bufferAfterMinutes: service === undefined ? '' : String(service.bufferAfterMinutes),
      /*
       * Écrit dans la langue de l'écran (#1123).
       *
       * `defaultValues` n'est lu qu'au **montage** ; le sélecteur de langue du
       * rail, lui, rejoue la route sans démonter ce formulaire. C'est l'effet
       * juste au-dessous qui réécrit le champ quand la langue bouge (#1327).
       */
      price: service === undefined ? '' : formatAmountInput(service.price, display),
    },
    mode: 'onTouched',
  });

  /**
   * La langue dans laquelle le champ de prix est **actuellement écrit** — #1327.
   *
   * Une référence et non un état : elle ne pilote aucun rendu, elle sert à savoir
   * avec quels séparateurs relire la saisie avant de la réécrire. Initialisée à
   * la langue du montage, celle de `defaultValues`.
   *
   * Elle n'avance qu'aux deux moments où le texte du champ change **vraiment**
   * de langue : la réécriture réussie de l'effet ci-dessous, et une frappe de la
   * gérante (l'`onChange` posé sur `register('price')`). L'avancer après une
   * réécriture **refusée** laisserait la référence mentir — le texte est resté
   * écrit dans l'ancienne langue — et la bascule suivante relirait la saisie avec
   * des séparateurs qu'elle n'a jamais employés : « 35,005 » refusé en français
   * deviendrait « 35005,00 » au retour, un prix mille fois trop élevé.
   */
  const priceDisplayRef = useRef<DisplayLocale>(display);

  /**
   * Le prix se réécrit quand la langue de l'écran change — deuxième critère
   * d'acceptation de #1327.
   *
   * Le sélecteur de langue du rail pose un cookie et laisse Next rejouer la route
   * **sans navigation** (`i18n/actions.ts`) : ce formulaire n'est pas démonté, et
   * une fiche pré-remplie « 10,00 » restait écrite à la française sous un gabarit
   * qui annonçait désormais « 35.00 ». Rien ne s'y perdait — `parseAmountInput`
   * reste tolérant aux deux séparateurs —, mais l'écran se contredisait à
   * l'endroit exact où il demande de recopier une forme.
   *
   * Trois précautions :
   *
   * - la relecture se fait avec la langue **d'avant**, celle dans laquelle la
   *   saisie a été écrite (`reformatAmountInput`). Relire avec la nouvelle
   *   réinterpréterait « 1,234 » ;
   * - une saisie illisible est **laissée telle quelle**, et la référence de
   *   langue ne bouge alors pas : un montant plus précis que la devise
   *   (« 35,005 ») reste écrit dans la langue où il a été tapé, et la bascule
   *   suivante le relira avec les bons séparateurs plutôt que d'y voir un
   *   groupement de milliers ;
   * - `shouldDirty: false` — cette réécriture n'est pas une modification de la
   *   gérante, et marquer le formulaire modifié ferait mentir tout garde-fou de
   *   sortie qui s'y adosserait.
   *
   * Le **rejeu de la validation** n'est plus ici : il vaut pour tous les champs
   * fautifs de ce formulaire, et plus seulement pour le prix, depuis #1354 —
   * c'est `useLocalizedFieldErrors` qui s'en charge juste en dessous. Cet effet
   * est déclaré **avant** lui à dessein : les effets se jouent dans l'ordre de
   * leurs crochets, et rejouer la validation du prix avant sa réécriture le
   * jugerait sur le texte de la langue d'avant.
   */
  useEffect(() => {
    const from = priceDisplayRef.current;

    if (from.locale === display.locale) {
      return;
    }

    const rewritten = reformatAmountInput(getValues('price'), currency, from, display);

    if (rewritten !== null) {
      priceDisplayRef.current = display;
      setValue('price', rewritten, { shouldDirty: false, shouldTouch: false });
    }
  }, [currency, display, getValues, setValue]);

  /**
   * Les messages de **champ** suivent la langue — #1354.
   *
   * Sept champs sur huit gardaient la phrase de leur refus telle que zod
   * l'avait écrite à la validation ; seul le prix était rejoué (#1327). Le
   * crochet rejoue la validation des champs **déjà fautifs**, et de ceux-là
   * seulement — un formulaire ne se met pas à reprocher un champ jamais rempli
   * parce qu'on a changé de langue.
   *
   * Le conflit d'adresse est l'autre moitié : c'est un refus de l'API, qu'aucune
   * validation locale ne saurait retrouver. Il est posé par son **code** et le
   * crochet le réécrit, ce qui l'exclut du rejeu — sans cela, la validation
   * locale trouverait l'adresse valable et effacerait le refus.
   */
  const { postFieldRefusal, clearFieldRefusals } = useLocalizedFieldErrors({
    locale,
    errors,
    trigger,
    setError,
    // Le conflit ne peut venir que de l'adresse : c'est la seule unicité que
    // porte la table, et cet écran la nomme mieux que le contrat. Le code lu est
    // celui que l'API rend réellement — `SERVICE_SLUG_TAKEN`, et non le
    // `CONFLICT` générique qu'elle ne sert pas ici (#1367).
    own: (code) =>
      code === CATALOG_ERROR_CODES.SERVICE_SLUG_TAKEN ? t('errors.slugTaken') : null,
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
    clearFieldRefusals();
    setSaved(false);

    const price = parseAmountInput(values.price, currency, display);

    if (price === null) {
      // Le schéma l'a déjà refusé ; ce garde-fou existe parce qu'une exception
      // levée dans ce rappel remonterait telle quelle depuis `handleSubmit` —
      // l'écran n'afficherait rien, le bouton reprendrait son état de repos, et
      // rien n'aurait été enregistré. Un échec muet est la pire des réponses.
      setError('price', { message: amountMessage });
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
      if (renewIfExpired(result)) {
        return;
      }
      if (result.code === CATALOG_ERROR_CODES.SERVICE_SLUG_TAKEN) {
        // Le conflit ne peut venir que du slug : c'est la seule unicité que
        // porte la table. Le message se pose donc sur le champ qui se corrige,
        // pas en bandeau au-dessus du formulaire — et par son **code**, pour
        // qu'il suive la langue comme le reste (#1354).
        //
        // Le code testé est celui que l'API **rend** : `ServiceSlugTakenError`
        // pose `SERVICE_SLUG_TAKEN` en 409 (`catalog.errors.ts`), et rien sur ces
        // deux routes ne sert le `CONFLICT` générique qu'on lisait jusqu'ici. Le
        // refus partait donc au bandeau, et le champ `Adresse publique` restait
        // muet — avec lui, le chemin `postFieldRefusal` de #1354 n'était pas
        // atteint en production sur cet écran (#1367).
        postFieldRefusal('slug', result.code);
        return;
      }
      setFailure({ code: result.code });
      return;
    }

    if (service === undefined) {
      const sheet = adminServicePath(tenantSlug, result.data.id);

      // L'annonce part **avant** la navigation, et porte le chemin où elle doit
      // se lire : elle attend la fiche plutôt que de clignoter une demi-seconde
      // au-dessus du formulaire qu'on quitte (#1037). Le nom vient de la réponse
      // de l'API et non de la saisie — le serveur est ce qui fait foi de ce qui
      // a été enregistré.
      announce({ kind: 'service-created', subject: result.data.name, path: sheet });
      router.push(sheet);
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
        <Notification tone="success" title={t('savedTitle')}>
          <p>{t('savedBody')}</p>
        </Notification>
      ) : null}

      {failure === null ? null : (
        <Notification tone="danger" title={t('failureTitle')}>
          {/* La phrase est écrite ici, dans la langue de ce rendu (#1327). Le
              seul refus que cet écran nomme lui-même — le conflit de slug — se
              pose sur son champ, pas dans ce bandeau. */}
          <p>{refusalMessage(failure, locale)}</p>
        </Notification>
      )}

      <Field
        id="service-name"
        label={t('name')}
        required
        disabled={!canManage}
        error={errors.name?.message}
        {...register('name')}
      />

      <TextArea
        id="service-description"
        label={t('description')}
        hint={t('descriptionHint')}
        disabled={!canManage}
        error={errors.description?.message}
        {...register('description')}
      />

      <Select
        id="service-category"
        label={t('category')}
        hint={t('categoryHint')}
        disabled={!canManage}
        error={errors.categoryId?.message}
        {...register('categoryId')}
      >
        <option value="">{t('unclassified')}</option>
        {/* Le nom d'une rubrique est la saisie du salon : il n'est pas traduit. */}
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </Select>

      <Field
        id="service-duration"
        label={t('duration')}
        required
        inputMode="numeric"
        placeholder="60"
        hint={t('durationHint')}
        disabled={!canManage}
        error={errors.durationMinutes?.message}
        {...register('durationMinutes')}
      />

      <Field
        id="service-buffer-before"
        label={t('bufferBefore')}
        inputMode="numeric"
        placeholder="0"
        hint={t('bufferBeforeHint')}
        disabled={!canManage}
        error={errors.bufferBeforeMinutes?.message}
        {...register('bufferBeforeMinutes')}
      />

      <Field
        id="service-buffer-after"
        label={t('bufferAfter')}
        inputMode="numeric"
        placeholder="0"
        hint={t('bufferAfterHint')}
        disabled={!canManage}
        error={errors.bufferAfterMinutes?.message}
        {...register('bufferAfterMinutes')}
      />

      {/* La durée est mise en forme par `lib/format.ts`, dans la langue de
          l'écran : « 1 h 15 » en français, « 1 hr 15 » en anglais
          (`messages/<langue>/format.json`). Le relief reste sur la valeur, et
          non sur la phrase : d'où `t.rich` plutôt qu'une phrase coupée en trois
          clés, qu'aucun traducteur ne pourrait réordonner. */}
      <p className="spa-admin-toolbar__hint">
        {t.rich('occupied', {
          duration: formatDuration(occupied, { locale }),
          strong: (parts) => <strong>{parts}</strong>,
        })}
      </p>

      {/* Le code devise est explicite dans l'étiquette, et le montant reste un
          entier de plus petite unité de bout en bout (`parseAmountInput`). */}
      <Field
        id="service-price"
        label={t('price', { currency })}
        required
        inputMode="decimal"
        placeholder={priceExample}
        hint={t('priceHint')}
        disabled={!canManage}
        error={errors.price?.message}
        {...register('price', {
          // Ce que la gérante tape est écrit dans la langue de l'écran qu'elle a
          // sous les yeux : la référence se recale ici, sinon une bascule laissée
          // sans réécriture (montant illisible) la ferait relire une frappe
          // neuve avec les séparateurs d'une langue qu'elle a quittée.
          onChange: () => {
            priceDisplayRef.current = display;
          },
        })}
      />

      <Field
        id="service-slug"
        label={t('slug')}
        hint={service === undefined ? t('slugHintNew') : t('slugHintEdit')}
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
          {service === undefined ? t('create') : t('save')}
        </Button>
      ) : (
        <p className="spa-admin-toolbar__hint">{t('restricted')}</p>
      )}
    </form>
  );
}
