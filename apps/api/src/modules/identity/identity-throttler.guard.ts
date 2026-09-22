import { createHmac, randomBytes } from 'node:crypto';

import { Injectable, SetMetadata, type CustomDecorator, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';

import { normalizeEmail } from './email';
import { readRefreshCookie } from './refresh-cookie';
import { TokenService } from './token.service';

/**
 * Limitation de débit comptée par autre chose que l'adresse IP, là où l'adresse
 * ne dit plus rien (#860, puis #1127).
 *
 * ## Le défaut corrigé
 *
 * `ThrottlerGuard` compte par `req.ip`, et c'est le bon compteur tant que
 * l'adresse désigne quelqu'un. Sur les routes d'authentification, elle ne
 * désigne personne : **aucun navigateur ne les appelle**. Le front Next les
 * relaie depuis son serveur (`apps/web/lib/api-client.ts`, `openSession`), et
 * `trust proxy` n'y changerait rien puisqu'il n'y a pas de mandataire — c'est un
 * appel serveur à serveur. Tous les établissements arrivent donc sur un seul
 * compteur, celui de la tâche ECS du front.
 *
 * Les quotas valaient par conséquent pour **le produit entier** : trente
 * renouvellements par minute pour tous les salons (#860), puis dix connexions
 * par minute pour tous les salons (#1127) — onze gérants qui ouvrent leur
 * back-office à 9 h, et le onzième reçoit « Trop de tentatives ». Le plafond ne
 * protégeait plus un compte, il rationnait la plateforme. C'est aussi ce qui a
 * rendu `develop` rouge : la suite E2E tourne sur un worker unique et franchit
 * le seuil avant son dernier scénario.
 *
 * ## Deux compteurs de remplacement, un par nature de route
 *
 * Aucun des deux n'est l'adresse, et aucun des deux n'est le même : ce que
 * chaque route protège n'est pas la même chose.
 *
 * ### `@ThrottleBySession()` — le `sid` du jeton (#860)
 *
 * Pour `POST /auth/refresh`, dont l'appelant **prouve** déjà qui il est. Le
 * jeton de rafraîchissement porte l'identifiant de session (`sid`,
 * `token.service.ts`), et cet identifiant est le seul qui tienne : il est stable
 * d'une rotation à l'autre — contrairement au `jti`, neuf à chaque émission,
 * dont un compteur repartirait de zéro à chaque renouvellement réussi et ne
 * limiterait donc rien.
 *
 * Le jeton est **vérifié** avant d'en tirer le compteur, et ce n'est pas une
 * précaution de forme. Un `sid` lu sans vérifier la signature serait une valeur
 * que l'appelant choisit : il lui suffirait d'en tirer une neuve à chaque
 * requête pour n'être jamais compté, et chaque valeur inventée créerait une
 * entrée de plus dans le stockage du limiteur — un quota contournable, doublé
 * d'une consommation mémoire sans borne. La vérification est un HMAC-SHA256 sur
 * quelques centaines d'octets, que le service refait de toute façon juste après.
 *
 * ### `@ThrottleByTarget()` — la cible des identifiants (#1127)
 *
 * Pour les routes qui **jugent un mot de passe** : `POST /auth/login`,
 * `POST /auth/register`, `POST /platform/auth/login`. L'appelant n'y prouve
 * rien — c'est tout l'objet de l'appel —, mais il **désigne** quelque chose : le
 * compte qu'il prétend ouvrir, ou l'établissement où il prétend en créer un.
 * C'est cette désignation que l'on compte, et non l'origine de l'appel, qui est
 * constante.
 *
 * Ce que chaque route désigne lui est propre, et c'est l'argument du décorateur
 * qui le dit — `@ThrottleByTarget({ tenant, account })`, champ par champ :
 *
 * | Route | Cible comptée | Ce que la borne protège |
 * |---|---|---|
 * | `/auth/login` | établissement **+** adresse e-mail | le forçage du mot de passe **d'un compte** |
 * | `/auth/register` | établissement seul | la création de comptes en masse **dans un salon** |
 * | `/platform/auth/login` | adresse e-mail seule | le forçage du mot de passe d'un opérateur |
 *
 * L'inscription ne se compte délibérément **pas** par adresse e-mail : un
 * attaquant qui crée des comptes en varie une à chaque essai, et un compteur par
 * adresse n'aurait borné que ce qui échouait déjà — deux inscriptions de la même
 * adresse dans le même salon, que l'unique `(tenant_id, email)` refuse. Le salon
 * est l'unité qui a un sens : c'est lui qu'on inonde, et c'est lui qui paie.
 *
 * ## Pourquoi la connexion ne se compte pas par session, elle
 *
 * Le cookie de rafraîchissement est posé sur `/api/v1/auth`, donc joint aussi à
 * `/auth/login` : y compter par session serait techniquement possible, et rendrait
 * le forçage de mots de passe **amplifiable** — une session ouverte donne un
 * compteur neuf, et l'on ouvre une session avec le compte que l'on possède déjà.
 * Le marquage est donc explicite route par route, jamais déduit de la présence du
 * cookie.
 *
 * ## Le compteur n'est pas choisissable par l'appelant
 *
 * Deux propriétés le tiennent, et les deux comptent.
 *
 * **Il est normalisé** avant d'être compté — `normalizeEmail` pour l'adresse,
 * élagage et minuscules pour le slug, exactement ce que `emailSchema` et
 * `slugSchema` de `@spa/shared` appliquent à la frontière. Sans cela,
 * `Admin@E2E.test`, ` admin@e2e.test ` et `admin@e2e.test` seraient trois
 * compteurs pour un seul compte, et le quota se remettrait à zéro à chaque
 * variation de casse. La garde s'exécute **avant** le `ValidationPipe` — c'est
 * l'ordre du cycle de Nest —, si bien qu'elle voit le corps brut et doit
 * normaliser elle-même.
 *
 * **Il est haché**, et avec un sel tiré au démarrage. La clé du limiteur n'est
 * donc jamais une adresse e-mail lisible : ni en mémoire, ni dans une trace de
 * débogage du stockage, ni dans un vidage de tas. Un SHA-256 nu ne suffirait pas
 * — une adresse se retrouve par dictionnaire en quelques secondes —, d'où le
 * HMAC. Le sel vit le temps du processus, ce qui est exactement la portée du
 * stockage du limiteur, en mémoire de tâche lui aussi : les deux redémarrent
 * ensemble, et un sel persistant n'aurait rien gardé de plus.
 *
 * ## Ce que ce compteur ne borne pas, et qui reste ouvert
 *
 * Un attaquant choisit la cible qu'il nomme, donc le compteur qu'il consomme :
 * varier l'adresse à chaque essai lui rend un quota neuf. Ce n'est pas une
 * régression — l'adresse IP qu'il consommait avant était celle du front, partagée
 * avec tous les clients légitimes, et un attaquant distribué la contournait déjà.
 * Ce que la cible apporte est précisément ce que le critère demande : le forçage
 * **d'un compte donné** reste borné, et il ne l'est plus aux dépens des autres.
 *
 * Reste donc à borner le **flot** lui-même, ce qu'aucun compteur applicatif ne
 * fera tant que l'adresse réelle du visiteur n'est pas propagée par le serveur
 * Next jusqu'ici. Doubler la cible d'un second compteur sur `req.ip` ne le ferait
 * pas non plus : ce serait remettre le plafond de la plateforme entière derrière
 * un nombre plus grand, c'est-à-dire refaire le défaut que ce fichier corrige.
 * La borne qui tient à ce stade est celle de l'entrée — le limiteur de l'ALB,
 * `infra/terraform/` — et la propagation de l'adresse réelle est un chantier à
 * elle seule.
 *
 * ### Et ce que cela coûte en mémoire — le point à surveiller (#1128)
 *
 * Le stockage par défaut de `@nestjs/throttler`, `ThrottlerStorageService`, est
 * une `Map` de processus **qui ne supprime jamais rien** : une clé y naît au
 * premier appel et y reste jusqu'au redémarrage de la tâche, seul son compteur
 * décroît. Tant que `/auth/login` n'avait qu'une clé — l'adresse du front —,
 * cela ne se voyait pas. Une clé par cible, elle, est une clé que l'appelant
 * fait naître : un slug inventé suffit, et il coûte moins qu'une connexion
 * puisque la validation le refuse **après** cette garde.
 *
 * L'ordre de grandeur reste celui d'une attaque soutenue — quelques centaines
 * d'octets par entrée, donc des heures de trafic maximal pour peser —, et la
 * borne réelle est là encore celle de l'entrée. Mais c'est une croissance que
 * seul un stockage **borné ou partagé** fermera : celui de Redis, que le MVP n'a
 * pas encore câblé pour ce module, ou un stockage maison qui expulse ses entrées
 * expirées. Le même stockage porte un second défaut de la bibliothèque, et de la
 * même famille : `resetBlockdRequest` annule les minuteries de **toutes** les
 * clés du limiteur, si bien qu'un compteur bloqué quelque part fige la
 * décroissance des autres jusqu'à leur propre remise à zéro. Les deux sont suivis
 * hors de ce ticket — les corriger, c'est remplacer le stockage.
 *
 * ## Le repli, et pourquoi il reste l'adresse IP
 *
 * Une requête qui ne prouve aucune session, ou dont le corps ne nomme aucune
 * cible exploitable, retombe sur `req.ip` — c'est-à-dire sur le comportement
 * d'origine. Ce repli ne concerne plus que les corps malformés, que le
 * `ValidationPipe` refusera juste après : les connexions légitimes, elles,
 * nomment toutes leur cible et ne partagent plus ce compteur-là.
 *
 * ## Pourquoi une garde et non l'option `getTracker` de `@Throttle`
 *
 * `@Throttle({ default: { getTracker } })` accepte bien une fonction par route,
 * mais une fonction posée dans un décorateur n'est pas un fournisseur : elle n'a
 * pas `TokenService`, donc pas le secret, donc pas de vérification possible pour
 * le compteur par session. D'où une garde, qui est le seul endroit où
 * l'injection existe.
 */

/**
 * Marque une route dont le quota se compte par session.
 *
 * @see THROTTLE_BY_TARGET pour les routes qui ne prouvent aucune session.
 */
export const THROTTLE_BY_SESSION = 'identity/throttle-by-session';

/** @see THROTTLE_BY_SESSION */
export const ThrottleBySession = (): CustomDecorator<string> =>
  SetMetadata(THROTTLE_BY_SESSION, true);

/**
 * Les champs du corps qui désignent la cible d'une route d'identifiants.
 *
 * `tenant` et `account` sont facultatifs l'un comme l'autre, et leur absence est
 * un choix de conception, pas un oubli : voir le tableau de l'en-tête.
 */
export interface ThrottleTargetFields {
  /** Le champ qui porte le slug de l'établissement, s'il est compté. */
  readonly tenant?: string;
  /** Le champ qui porte l'adresse e-mail du compte visé, si elle est comptée. */
  readonly account?: string;
}

/** Métadonnée portée par `@ThrottleByTarget()`. */
export const THROTTLE_BY_TARGET = 'identity/throttle-by-target';

/**
 * Marque une route dont le quota se compte par **cible d'identifiants** plutôt
 * que par adresse IP (#1127).
 *
 * @see THROTTLE_BY_TARGET
 */
export const ThrottleByTarget = (fields: ThrottleTargetFields): CustomDecorator<string> =>
  SetMetadata(THROTTLE_BY_TARGET, fields);

/**
 * Le sel du hachage des cibles — tiré une fois, au chargement du module.
 *
 * Voir l'en-tête, « Le compteur n'est pas choisissable par l'appelant » : il a
 * la même portée que le stockage du limiteur, en mémoire du processus.
 */
const TARGET_SALT = randomBytes(32);

/**
 * L'empreinte d'une cible — jamais la cible elle-même.
 *
 * Tronquée à 128 bits : c'est déjà hors de portée d'une collision recherchée,
 * et une clé de limiteur n'a pas à peser davantage.
 */
function digestTarget(value: string): string {
  return createHmac('sha256', TARGET_SALT).update(value).digest('base64url').slice(0, 22);
}

/**
 * La forme canonique d'un champ de cible, ou `null` s'il n'en est pas un.
 *
 * `null` plutôt qu'une chaîne vide : un corps sans e-mail exploitable n'a pas de
 * cible, et lui en fabriquer une le rangerait avec tous les autres corps
 * malformés dans un compteur commun — ce que le repli sur l'adresse fait déjà,
 * et dit.
 */
function normalizeField(value: unknown, normalize: (raw: string) => string): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalize(value);
  return normalized === '' ? null : normalized;
}

/** Élagage et minuscules — ce que `slugSchema` de `@spa/shared` applique. */
function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

@Injectable()
export class IdentityThrottlerGuard extends ThrottlerGuard {
  public constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly tokens: TokenService,
  ) {
    super(options, storage, reflector);
  }

  /**
   * Le compteur de cette requête.
   *
   * `context` est déclaré **facultatif** bien qu'il soit toujours passé : le
   * type public `ThrottlerGetTrackerFunction` le prévoit — `(req, context)` — et
   * la garde l'appelle bien avec deux arguments, mais la méthode de la classe de
   * base, elle, n'en déclare qu'un. Une redéfinition qui exigerait le second ne
   * serait pas assignable à celle qu'elle remplace, et TypeScript la refuserait.
   */
  protected override async getTracker(
    request: Record<string, unknown>,
    context?: ExecutionContext,
  ): Promise<string> {
    if (context !== undefined) {
      const tracker = await this.trackerFor(request as unknown as Request, context);

      if (tracker !== null) {
        return tracker;
      }
    }

    return super.getTracker(request);
  }

  /**
   * Le compteur que la route réclame, ou `null` si la requête ne le prouve ni ne
   * le nomme — auquel cas l'appelant retombe sur l'adresse.
   *
   * Les deux marquages s'excluent : une route se compte par session **ou** par
   * cible, jamais par les deux. Le premier gagne, et c'est sans conséquence —
   * aucune route ne porte les deux décorateurs, et l'en-tête dit pourquoi
   * `/auth/login` ne peut pas porter le premier.
   */
  private async trackerFor(request: Request, context: ExecutionContext): Promise<string | null> {
    if (this.tracksBySession(context)) {
      return this.sessionTracker(request);
    }

    const fields = this.targetFields(context);
    return fields === null ? null : this.targetTracker(request, fields);
  }

  /** La route demande-t-elle un compteur par session ? */
  private tracksBySession(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(THROTTLE_BY_SESSION, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  /** Les champs de cible de la route, ou `null` si elle n'en compte aucune. */
  private targetFields(context: ExecutionContext): ThrottleTargetFields | null {
    return (
      this.reflector.getAllAndOverride<ThrottleTargetFields | undefined>(THROTTLE_BY_TARGET, [
        context.getHandler(),
        context.getClass(),
      ]) ?? null
    );
  }

  /**
   * La session que cette requête prouve, ou `null` si elle n'en prouve aucune.
   *
   * Préfixé : le compteur est une chaîne libre, et deux sources qui s'y
   * mélangeraient — un `sid` et une adresse IP — se confondraient un jour.
   */
  private async sessionTracker(request: Request): Promise<string | null> {
    const token = readRefreshCookie(request);

    if (token === null) {
      return null;
    }

    try {
      const { sid } = await this.tokens.verifyRefreshToken(token);
      return `session:${sid}`;
    } catch {
      // Jeton contrefait, expiré ou illisible : il ne désigne aucune session, et
      // le laisser en désigner une serait rendre le quota contournable.
      return null;
    }
  }

  /**
   * La cible que le corps de cette requête nomme, ou `null` s'il n'en nomme
   * aucune d'exploitable.
   *
   * Le corps est lu **brut** : la garde précède le `ValidationPipe`, et c'est
   * précisément pourquoi rien de ce qui en sort n'est cru sur parole — chaque
   * champ est retypé, normalisé, puis haché.
   *
   * Les deux moitiés sont jointes **préfixées de leur longueur**, et non par un
   * séparateur. Un séparateur aurait supposé un caractère que ni le slug ni
   * l'adresse ne peuvent porter — ce qui est vrai après validation, mais pas
   * ici : le corps est brut, et rien n'empêche d'y glisser le séparateur choisi
   * pour faire coïncider deux cibles distinctes en une seule chaîne, donc en un
   * seul compteur. La longueur, elle, ne se falsifie pas.
   */
  private targetTracker(request: Request, fields: ThrottleTargetFields): string | null {
    // `@ThrottleByTarget({})` ne désigne rien : le laisser produire une clé
    // rendrait un compteur **unique pour tous les appelants**, c'est-à-dire
    // exactement le plafond de plateforme que ce fichier corrige. Le repli sur
    // l'adresse est ce que ce marquage-là mérite.
    if (fields.tenant === undefined && fields.account === undefined) {
      return null;
    }

    const body: unknown = request.body;

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }

    const record = body as Record<string, unknown>;

    const tenant =
      fields.tenant === undefined
        ? null
        : normalizeField(record[fields.tenant], normalizeSlug);
    const account =
      fields.account === undefined
        ? null
        : normalizeField(record[fields.account], normalizeEmail);

    // Un champ demandé et absent n'est pas une cible partielle : c'est un corps
    // que la validation refusera, et le compter à part de sa vraie cible
    // donnerait un quota de plus à qui omet le champ.
    if (
      (fields.tenant !== undefined && tenant === null) ||
      (fields.account !== undefined && account === null)
    ) {
      return null;
    }

    const scope = tenant ?? '';
    const subject = account ?? '';

    return `target:${digestTarget(`${scope.length}:${scope}${subject.length}:${subject}`)}`;
  }
}
