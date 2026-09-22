'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  errorMessage,
  loginRequestSchema,
  zodErrorMap,
  type Locale,
  type LoginRequest,
} from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification, type NotificationTone } from '@/components/ui/notification';
import type { SessionNotice } from '@/lib/session-refresh';

import { adminLoginAction, adminLogoutAction } from '../actions';
import { adminCalendarPath } from '../paths';
import { adminLandingPath } from './navigation';

/**
 * Connexion au back-office.
 *
 * ## Le schéma vient du contrat, il n'est pas réécrit
 *
 * `loginRequestSchema` de `@spa/shared` est celui que l'API applique : la même
 * règle des deux côtés, écrite une fois (web-frontend §4). Le `tenantSlug` n'y
 * figure pas et n'a pas à y figurer — il vient de l'URL, et l'action serveur le
 * joint au corps.
 *
 * ## Ce que cet écran ne juge toujours pas : le droit d'ouvrir un écran
 *
 * Il ouvre une session pour toute identité valide de l'établissement, y compris
 * une cliente, et **n'autorise rien** : la seule garde qui compte reste celle de
 * l'API, qu'aucun front ne peut contourner, et chaque page traduit son 403 en
 * message lisible.
 *
 * Ce qu'il décide, en revanche, c'est **où déposer la personne qui vient de
 * s'identifier** — et c'est autre chose. Jusqu'à #618 il déposait tout le monde
 * sur les réglages, écran `@AuthAtLeast('ADMIN')` : le premier écran d'une
 * praticienne après son mot de passe était « Accès réservé ». L'interface
 * conduisait elle-même là où elle allait refuser.
 *
 * La destination vient donc du **sommaire**, `adminLandingPath` : la première
 * section que le rail ouvrirait à ce rôle. Aucun rang n'est réécrit ici — c'est
 * tout l'intérêt, une seconde table de droits aurait divergé de la première au
 * premier changement de seuil.
 *
 * ## Le cas sans destination
 *
 * Un compte `client` n'a aucune section : il n'y a rien où l'envoyer, et
 * l'envoyer quelque part serait recommencer le défaut. On le lui dit sur cet
 * écran — et l'on tente de refermer la session qu'on vient d'ouvrir, parce
 * qu'annoncer l'absence d'accès tout en laissant vivre sept jours un cookie de
 * session sur `/{slug}/admin` serait dire une chose et en faire une autre. Le
 * message dit ensuite laquelle des deux choses a eu lieu : promettre une
 * fermeture qui a échoué serait retomber dans le même travers.
 *
 * ## Le `<form>` est la carte, il n'est pas dedans (#699)
 *
 * Deux défauts d'un même balisage, relevés par la campagne de QA `20260915-1`.
 *
 * Le `<form>` était **nu**, rangé dans une `<section className="spa-admin__section">`.
 * Or c'est cette classe qui donne le rythme vertical — `display: flex` en
 * colonne, `gap: var(--spa-space-3)` —, et elle n'écartait donc que ses trois
 * enfants directs : le titre, la notification et le formulaire. À l'intérieur,
 * champs et bouton redevenaient des blocs du flux normal, empilés à **0 px** —
 * le bord haut de « Se connecter » touchait le bord bas du champ « Mot de
 * passe », aux quatre largeurs mesurées, là où la connexion cliente laisse
 * 16 px. C'est exactement le défaut que #633 a corrigé sur `/catalogue/rubriques`,
 * et le remède est le même : le `<form>` **est** la carte, le titre descend
 * dedans. Rien n'est ajouté au CSS pour cela.
 *
 * La carte n'était par ailleurs pas bornée : `.spa-admin__content` vaut ici
 * toute la fenêtre — l'écran de connexion est le seul du back-office servi sans
 * rail —, si bien que les champs s'étiraient sur environ 1 400 px à 1920 px,
 * contre environ 470 px sur `/compte/connexion`. #630 avait borné les
 * formulaires d'administration à 44 rem ; celui-ci était resté hors de sa liste.
 * `spa-admin-form` l'y fait entrer.
 *
 * Le centrage vient de la conjonction des deux classes, et non d'une troisième :
 * `admin/shell.css` centre une carte de saisie qui est l'unique enfant de la
 * zone de contenu — ce qu'est celle-ci, et qu'aucun autre écran borné n'est.
 * C'est pourquoi la page ne rend que ce composant, sans enveloppe.
 *
 * `block` sur le bouton n'en devient que plus juste : il mesure désormais une
 * colonne bornée, et non la fenêtre (`styles/README.md` §2).
 *
 * ## Les mots viennent du catalogue `admin-auth` (#853)
 *
 * Titres, libellés et encarts sont lus par `useTranslations`. Ce qui change en
 * plus des libellés, c'est la **source du texte d'un refus** : jusqu'ici l'écran
 * réaffichait le `message` que l'API met dans son corps, écrit dans une langue
 * qui n'est pas négociée et destiné au diagnostic. Il lit désormais
 * `errorMessage(code, locale)` du contrat partagé (#845), qui porte une phrase
 * par code et par langue — c'est la règle que l'espace client suit depuis #847,
 * et celle qu'énonce `errors/error-codes.ts` : *« le front réagit sur `code`,
 * jamais sur `message` »*.
 */

/** Ce qu'un échec affiche : un titre **et** son explication, jamais l'un sans l'autre. */
interface AdminLoginFailure {
  readonly title: string;
  readonly message: string;
}

/**
 * Les causes d'échec que cet écran sait nommer, et la clé de catalogue de
 * chacune (#759, #853).
 *
 * ## Le défaut corrigé : un titre constant au-dessus d'un corps variable
 *
 * Le corps de l'encart dépendait déjà du `code`, le titre non — il valait
 * « Connexion refusée » quoi qu'il arrive. Sur une coupure réseau, l'écran
 * affichait donc « Connexion refusée » au-dessus de « Le service est
 * momentanément injoignable » : le titre imputait la faute aux identifiants
 * saisis, le corps au serveur. Les deux ne peuvent pas être vrais, et c'est le
 * titre que l'œil lit d'abord — un gérant en conclut qu'il s'est trompé de mot
 * de passe et va changer ce qui n'avait rien.
 *
 * Les deux moitiés se décident donc **ensemble**, sous une clé unique : les
 * séparer, c'était précisément ce qui les avait laissées diverger.
 *
 * ## Pourquoi le `code` et non le `message`
 *
 * `web-frontend` §2 et `docs/design/appointments/states.md` (« Règles
 * générales ») demandent de réagir sur le **`code`** de l'erreur typée
 * (`{ code, message, details }`), jamais sur le `message` : le message est ce
 * qui change d'une version d'API à l'autre — et il n'est pas traduit —, le code
 * est ce qui tient. C'est déjà ce que fait `guard.tsx` pour le texte des pages
 * du back-office.
 *
 * ## Les `HTTP_<statut>` sont énumérés avec leur code de contrat
 *
 * `api-client.ts` ne rend le code du contrat que si le corps de la réponse est
 * l'enveloppe `{ code, message, details }`. Une panne vue **de la passerelle** —
 * conteneur d'API éteint, ALB qui rend sa page 503, limiteur d'entrée qui rend
 * un 429 — n'a pas cette forme : le corps ne se parse pas et le code vaut
 * `HTTP_503` ou `HTTP_429`. C'est le cas le plus courant des deux en déployé, et
 * le laisser au repli neutre, c'était rater la panne que ce ticket vient nommer.
 * `lib/admin/checkout-summary.ts` apparie les deux écritures pour cette raison ;
 * ces codes-là ne sont pas des codes du contrat et ne heurtent pas le garde de
 * littéraux de `packages/shared` (#546).
 *
 * Le quota, lui, est celui de la route d'authentification : dix tentatives par
 * minute **sur ce compte** — l'établissement et l'adresse saisie — sur
 * `POST /auth/login` (`auth.controller.ts`, #1127). Passé ce quota, ce sont les
 * essais qui sont refusés, pas le mot de passe, et le réécrire n'y changerait
 * rien.
 *
 * ## Ce que le repli dit, et ce qu'il se garde de dire
 *
 * Un code absent de cette table n'est pas forcément un refus d'identité : le
 * filtre d'erreurs retombe sur `HTTP_<statut>` pour un statut qu'il ne sait pas
 * nommer, et `action-result.ts` produit `INTERNAL_ERROR` ou `VALIDATION_ERROR`
 * sans que l'API ait seulement été atteinte. Le repli reste donc **neutre** :
 * il constate que la connexion n'a pas eu lieu, sans désigner une cause qu'il
 * ignore. Reproduire « Connexion refusée » ici, c'était reproduire le défaut
 * pour tous les codes non énumérés.
 *
 * ## Une `Map`, et non un objet indexé
 *
 * `apiErrorSchema` accepte **n'importe quelle** chaîne comme `code`, à dessein
 * (`packages/shared/src/errors/api-error.ts`). Un objet littéral indexé par une
 * telle chaîne rend aussi ce qu'il hérite d'`Object.prototype` : un code
 * `valueOf` ou `__proto__` ne retomberait pas sur le repli mais rendrait un
 * objet, que `<Notification>` ne sait pas afficher — l'écran tomberait au lieu
 * d'afficher un refus. Une `Map` n'a pas de chaîne de prototype à traverser.
 */
type FailureKey = 'invalidCredentials' | 'unreachable' | 'throttled';

const FAILURE_KEYS: ReadonlyMap<string, FailureKey> = new Map<string, FailureKey>([
  [ERROR_CODES.INVALID_CREDENTIALS, 'invalidCredentials'],
  [ERROR_CODES.SERVICE_UNAVAILABLE, 'unreachable'],
  ['HTTP_503', 'unreachable'],
  [ERROR_CODES.TOO_MANY_REQUESTS, 'throttled'],
  ['HTTP_429', 'throttled'],
]);

/**
 * Le **ton** de chaque motif de retour — la seule part qui ne se traduise pas
 * (#860, #853).
 *
 * Le back-office ne portait aucun motif : un renouvellement refusé par le
 * limiteur déposait l'opérateur devant ce formulaire, muet, qui ne se lit que
 * d'une façon — « on m'a déconnecté ». Sa session était pourtant intacte.
 *
 * Deux encarts, et la distinction qu'ils portent est la seule qui compte :
 * `session-expiree` dit qu'il faut se reconnecter, `renouvellement-indisponible`
 * dit qu'il ne faut rien faire d'autre qu'attendre. Le ton suit — `warning` pour
 * une session finie, `info` pour une attente de quelques secondes.
 *
 * Séparé des causes d'échec à dessein : celles-ci disent ce qu'une **tentative
 * de connexion** a donné, celui-là ce qui a **amené ici**. Les deux encarts
 * peuvent d'ailleurs coexister — on peut échouer à se connecter sur un écran où
 * l'on vient d'arriver par un renouvellement raté.
 *
 * Les phrases sont au catalogue sous `admin-auth.login.notices`, **à la clé du
 * motif** : c'est la même chaîne que l'URL porte (`?motif=`), si bien qu'un
 * motif ajouté à `SESSION_NOTICES` sans ses deux traductions fait échouer `tsc`.
 */
const NOTICE_TONES: Readonly<Record<SessionNotice, NotificationTone>> = {
  'session-expiree': 'warning',
  'renouvellement-indisponible': 'info',
};

interface AdminLoginFormProps {
  readonly tenantSlug: string;
  /** Le motif qui a renvoyé ici, s'il y en a un. */
  readonly notice: SessionNotice | null;
}

export function AdminLoginForm({ tenantSlug, notice }: AdminLoginFormProps) {
  const t = useTranslations('admin-auth.login');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [failure, setFailure] = useState<AdminLoginFailure | null>(null);
  // Les refus des champs viennent de zod, donc de `zodErrorMap` — « adresse
  // e-mail attendue » et non « Invalid email » sous un formulaire français, ni
  // l'inverse sous un formulaire anglais (#845). Mémoïsé sur la langue, comme
  // les deux autres formulaires de cette surface : un résolveur neuf à chaque
  // frappe serait reconstruit par `react-hook-form` sans rien changer.
  //
  // `path` et `async` sont là pour le **typage** de `@hookform/resolvers`,
  // qui déclare `ParseParams` entier là où zod n'en lit qu'une partie : au
  // runtime, `safeParseAsync` force `async: true` et retombe sur `path: []`.
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
    mode: 'onTouched',
  });

  /** L'encart à afficher pour ce refus — titre et texte décidés du même geste. */
  function failureNotice(code: string): AdminLoginFailure {
    const key = FAILURE_KEYS.get(code);

    if (key === undefined) {
      return { title: t('failures.unknownTitle'), message: errorMessage(code, locale) };
    }

    return {
      title: t(`failures.${key}.title` as 'failures.unreachable.title'),
      message: t(`failures.${key}.message` as 'failures.unreachable.message'),
    };
  }

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    const result = await adminLoginAction(tenantSlug, values);

    if (!result.ok) {
      setFailure(failureNotice(result.code));
      return;
    }

    const landing = adminLandingPath(tenantSlug, result.data.role);

    if (landing === null) {
      // La fermeture peut échouer — action serveur injoignable, API éteinte — et
      // l'attendre sans filet ferait sortir le rejet de ce gestionnaire : plus
      // aucun message ne s'afficherait, sur l'écran même où une session vient
      // d'être ouverte. On la tente, on retient ce qu'elle a donné, et l'on dit
      // ensuite la vérité correspondante.
      const closed = await adminLogoutAction(tenantSlug).then(
        (outcome) => outcome.ok,
        () => false,
      );

      // Le mot de passe était bon : ce n'est pas un refus d'identité, et le dire
      // comme tel enverrait chercher une faute de frappe qui n'existe pas.
      setFailure({
        title: t('noAccess.title'),
        message: closed ? t('noAccess.closed') : t('noAccess.stillOpen'),
      });
      return;
    }

    router.replace(landing);
    // Les pages du back-office sont rendues côté serveur : sans ce
    // rafraîchissement, la navigation servirait le rendu fait **avant** que le
    // cookie de session n'existe, et rebondirait aussitôt sur cet écran.
    router.refresh();
  });

  return (
    <form
      className="spa-admin__section spa-admin-form"
      aria-labelledby="admin-connexion-titre"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h1 className="spa-admin__section-title" id="admin-connexion-titre">
        {t('title')}
      </h1>

      {notice === null ? null : (
        <Notification
          tone={NOTICE_TONES[notice]}
          title={t(`notices.${notice}.title` as 'notices.session-expiree.title')}
        >
          <p>{t(`notices.${notice}.body` as 'notices.session-expiree.body')}</p>
          {/*
           * Une reprise, comme l'exige `docs/design/appointments/states.md`
           * (« Règles générales ») de tout état d'erreur — et comme `guard.tsx`
           * en pose une sur les pages du back-office. Elle vise le planning et
           * non cet écran : c'est la garde d'une page qui repassera par la route
           * de renouvellement, avec les cookies qu'on vient précisément de ne
           * pas effacer. Rafraîchir cet écran-ci ne retenterait rien.
           */}
          {notice === 'renouvellement-indisponible' ? (
            <p>
              <Link href={adminCalendarPath(tenantSlug)}>{t('notices.retry')}</Link>
            </p>
          ) : null}
        </Notification>
      )}

      {failure === null ? null : (
        <Notification tone="danger" title={failure.title}>
          <p>{failure.message}</p>
        </Notification>
      )}

      <Field
        id="admin-login-email"
        label={t('email')}
        type="email"
        autoComplete="email"
        required
        error={errors.email?.message}
        {...register('email')}
      />
      <Field
        id="admin-login-password"
        label={t('password')}
        type="password"
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
  );
}
