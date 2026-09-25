'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  loginRequestSchema,
  zodErrorMap,
  type Locale,
  type LoginRequest,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification, type NotificationTone } from '@/components/ui/notification';
import { PasswordField } from '@/components/ui/password-field';
import type { SessionNotice } from '@/lib/session-refresh';

import { loginAction } from '../actions';
import { RETURN_QUERY_KEY, safeReturnPath, withReturnPath } from '../connexion/return-path';
import { accountPath } from '../paths';

/**
 * Connexion cliente (#47, premier critère).
 *
 * ## Le schéma vient du contrat, il n'est pas réécrit
 *
 * `loginRequestSchema` de `@spa/shared` est celui que l'API applique : la même
 * règle des deux côtés, écrite une fois (web-frontend §4). Le `tenantSlug` n'y
 * figure pas et n'a pas à y figurer — il vient de l'URL, et l'action serveur le
 * joint au corps.
 *
 * ## Ce que le formulaire ne fait pas : juger le mot de passe
 *
 * Aucune longueur minimale à la saisie. Une politique appliquée ici
 * verrouillerait les comptes antérieurs à son durcissement, et distinguerait
 * « trop court » de « faux » — c'est-à-dire dirait qu'un mot de passe court est
 * *le* mot de passe de ce compte. L'API rend un `INVALID_CREDENTIALS` indistinct,
 * et cet écran le répète tel quel.
 */
interface LoginFormProps {
  readonly tenantSlug: string;
  /** Le motif qui a renvoyé ici, s'il y en a un. */
  readonly notice: SessionNotice | null;
}

/**
 * Le **ton** de chaque motif — la seule part qui ne se traduise pas (#860, #847).
 *
 * `renouvellement-indisponible` est le cas que #860 a séparé : la session n'est
 * pas fermée, ses cookies sont en place, et le renouvellement suivant aboutira.
 * L'annoncer comme une expiration enverrait ressaisir un mot de passe dont
 * personne n'a besoin — et, sur un quota partagé, cela arrivait à des gens dont
 * la session avait encore six jours devant elle.
 *
 * Le ton suit la même distinction : `warning` pour une session finie, `info`
 * pour une attente de quelques secondes. Les phrases, elles, sont au catalogue
 * sous `account.login.notices`, **à la clé du motif** : c'est la même chaîne que
 * l'URL porte (`?motif=`), si bien qu'un motif ajouté à `SESSION_NOTICES` sans
 * ses deux traductions fait échouer `tsc`.
 */
const NOTICE_TONES: Readonly<Record<SessionNotice, NotificationTone>> = {
  'session-expiree': 'warning',
  'renouvellement-indisponible': 'info',
};

export function LoginForm({ tenantSlug, notice }: LoginFormProps) {
  const t = useTranslations('account.login');
  const locale = useLocale() as Locale;
  const router = useRouter();
  /*
   * La destination de retour, lue dans l'adresse et **rejugée ici** (#1087).
   *
   * Lue par le formulaire et non reçue en propriété de la page : le même
   * paramètre vaut pour l'inscription, qui le reçoit du lien croisé ci-dessous,
   * et faire porter la lecture par les deux écrans aurait dédoublé la règle sans
   * rien simplifier. Les deux pages sont `force-dynamic`, si bien que
   * `useSearchParams` ne leur coûte pas le rendu statique qu'elles n'ont pas.
   *
   * `safeReturnPath` refuse tout ce qui sort du salon courant — une URL absolue,
   * `//hôte`, un autre slug : sans cela, cet écran serait une redirection
   * ouverte, et c'est celui du produit où il faut le moins en poser.
   */
  const returnTo = safeReturnPath(useSearchParams().get(RETURN_QUERY_KEY), tenantSlug);
  const [failure, setFailure] = useState<string | null>(null);
  /*
   * Les refus des champs viennent de zod, donc de `zodErrorMap` — « Saisissez
   * une adresse e-mail valable. » et non « Enter a valid email address. » sous un
   * formulaire français, ni l'inverse sous un formulaire anglais (#1232). Sans
   * cette carte, le contrat rendait ses phrases dans la langue du **repli** de
   * `@spa/shared`, quelle que soit celle de l'écran.
   *
   * Mémoïsé sur la langue, comme les trois formulaires du back-office : un
   * résolveur neuf à chaque frappe serait reconstruit par `react-hook-form` sans
   * rien changer. `path` et `async` sont là pour le **typage** de
   * `@hookform/resolvers`, qui déclare `ParseParams` entier là où zod n'en lit
   * qu'une partie.
   */
  const resolver = useMemo(
    () => zodResolver(loginRequestSchema, { errorMap: zodErrorMap(locale), path: [], async: true }),
    [locale],
  );

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({
    resolver,
    defaultValues: { email: '', password: '' },
    // Le message apparaît quand on quitte le champ, pas à la première frappe.
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await loginAction(tenantSlug, values);

    if (!result.ok) {
      /*
       * L'action rend déjà une phrase dans la langue de la requête
       * (`errorMessage`, #847). Celle-ci est réécrite ici pour une seule raison :
       * `INVALID_CREDENTIALS` doit rester **indistinct** — ni « adresse
       * inconnue », ni « mot de passe faux » —, et c'est cet écran-là qui en
       * répond. La formulation du catalogue est la même que celle du contrat ;
       * l'avoir en propre est ce qui garantit qu'un durcissement du message
       * générique ne la rendra jamais bavarde.
       */
      setFailure(
        result.code === ERROR_CODES.INVALID_CREDENTIALS
          ? t('invalidCredentials')
          : result.message,
      );
      return;
    }

    // Là d'où l'on vient quand l'adresse le dit, l'espace client sinon (#1087).
    router.replace(returnTo ?? accountPath(tenantSlug));
    // La page de destination est rendue côté serveur : sans ce rafraîchissement,
    // la navigation servirait le rendu fait **avant** que le cookie de session
    // n'existe — l'espace client rebondirait sur cet écran, et le tunnel
    // redemanderait des coordonnées que le cookie de présence connaît (#1086).
    router.refresh();
  });

  return (
    <section className="spa-account__panel" aria-labelledby="connexion-titre">
      <h2 className="spa-account__section-title" id="connexion-titre">
        {t('title')}
      </h2>

      {notice === null ? null : (
        <Notification
          tone={NOTICE_TONES[notice]}
          title={t(`notices.${notice}.title` as 'notices.session-expiree.title')}
        >
          <p>{t(`notices.${notice}.body` as 'notices.session-expiree.body')}</p>
          {/*
           * Une reprise, comme l'exige `docs/design/appointments/states.md`
           * (« Règles générales ») de tout état d'erreur. Elle vise l'espace
           * client et non cet écran : c'est la garde de l'espace client qui
           * repassera par la route de renouvellement, avec les cookies qu'on
           * vient précisément de ne pas effacer.
           */}
          {notice === 'renouvellement-indisponible' ? (
            <p>
              <Link href={accountPath(tenantSlug)}>{t('notices.retry')}</Link>
            </p>
          ) : null}
        </Notification>
      )}

      {failure === null ? null : (
        <Notification tone="danger" title={t('failureTitle')}>
          <p>{failure}</p>
        </Notification>
      )}

      <form className="spa-account__form" onSubmit={(event) => void submit(event)} noValidate>
        <Field
          id="login-email"
          label={t('email')}
          type="email"
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />
        {/*
          `PasswordField` (#1044) et non un `Field type="password"` : WCAG 2.2,
          3.3.8 tient l'authentification pour accessible dès lors qu'on peut
          **voir** ce qu'on tape et le coller. Le bouton « Afficher / Masquer »
          est un vrai bouton, donc atteint et actionné au clavier, et rien
          n'entrave le collage depuis un gestionnaire de mots de passe.
        */}
        <PasswordField
          id="login-password"
          label={t('password')}
          autoComplete="current-password"
          required
          error={errors.password?.message}
          {...register('password')}
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
        {t('noAccount')}{' '}
        {/*
          Le retour traverse le lien (#1087) : une cliente venue du tunnel sans
          compte le crée et revient au tunnel, pas dans un espace client qu'elle
          n'a pas demandé à voir.
        */}
        <Link href={withReturnPath(accountPath(tenantSlug, '/inscription'), returnTo)}>
          {t('createAccount')}
        </Link>
      </p>
    </section>
  );
}
