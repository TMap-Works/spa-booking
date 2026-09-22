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
import { bearerToken } from './jwt-auth.guard';
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
 * ## Quatre compteurs de remplacement, un par nature de route
 *
 * Aucun n'est l'adresse, et aucun n'est le même : ce que chaque route protège
 * n'est pas la même chose. Trois d'entre eux comptent ce que l'appelant
 * **prouve** — une session, un compte, un jeton signé —, le quatrième ce qu'il
 * **désigne**, faute de pouvoir prouver quoi que ce soit.
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
 * ### `@ThrottleByPrincipal()` — le `sub` du jeton d'accès (#1128)
 *
 * Pour `GET /auth/me`, la seule route **authentifiée** de ce contrôleur. Son
 * compteur naturel est le compte qui l'appelle, et le jeton d'accès le porte
 * déjà : `sub`, vérifié ici comme le jeton de rafraîchissement l'est pour la
 * session, et pour la même raison — une revendication lue sans vérifier la
 * signature est une valeur que l'appelant choisit.
 *
 * Le nombre, lui, n'avait pas à changer : soixante par minute est large pour un
 * compte, et c'était le plafond du **produit entier** pour une route que le
 * back-office appelle à chaque rendu d'écran (`loadAdminShell`). Une poignée de
 * salons ouverts en même temps suffisait à le franchir, et le back-office se
 * fermait alors pour tout le monde.
 *
 * La garde du limiteur s'exécute **avant** `JwtAuthGuard` — c'est l'ordre des
 * gardes de Nest, celles du contrôleur d'abord — si bien qu'une requête sans
 * jeton valide arrive ici avant d'être refusée. Elle retombe sur l'adresse, ce
 * qui est exactement ce qu'il faut : le bruit des appels non authentifiés reste
 * borné sur un compteur commun, sans toucher à celui des comptes qui travaillent.
 *
 * ### `@ThrottleByToken()` — le jeton présenté (#1128)
 *
 * Pour `POST /auth/invitations/accept` et `POST /auth/password-reset/confirm`.
 * Ces deux-là ne nomment aucune cible : leur corps porte un jeton signé, et
 * c'est lui qui les autorise. Le compteur est donc le compte que ce jeton
 * désigne — son `sub` —, à condition que le jeton **vérifie**.
 *
 * Un jeton contrefait, expiré ou d'un autre usage ne désigne rien, et retombe
 * sur l'adresse. Ce n'est pas un pis-aller : le service refuse ces corps-là
 * avant le moindre bcrypt (`verifyInvitationToken` puis `hash`, jamais
 * l'inverse), ils ne coûtent donc presque rien, et les ranger tous ensemble sur
 * un compteur commun est précisément ce qu'on veut d'eux. Ce que le plafond
 * protège est le **coût du bcrypt** qu'un corps valide fait payer, et ce coût-là
 * se compte désormais par compte visé au lieu de se partager entre tous les
 * salons.
 *
 * Contrefaire ne rend donc aucun compteur neuf, et ne fait pas non plus naître
 * d'entrée dans le stockage : c'est ce qui distingue ce compteur de celui des
 * cibles, où la clé est ce que l'appelant écrit.
 *
 * ### `@ThrottleByTarget()` — la cible des identifiants (#1127, étendu en #1128)
 *
 * Pour les routes où l'appelant ne prouve rien — c'est tout l'objet de l'appel —
 * mais **désigne** quelque chose : le compte qu'il prétend ouvrir, celui dont il
 * prétend avoir oublié le mot de passe, ou l'établissement où il prétend créer
 * un compte. C'est cette désignation que l'on compte, et non l'origine de
 * l'appel, qui est constante.
 *
 * Ce que chaque route désigne lui est propre, et c'est l'argument du décorateur
 * qui le dit — `@ThrottleByTarget({ tenant, account })`, champ par champ :
 *
 * | Route | Cible comptée | Ce que la borne protège |
 * |---|---|---|
 * | `/auth/login` | établissement **+** adresse e-mail | le forçage du mot de passe **d'un compte** |
 * | `/auth/register` | établissement seul | la création de comptes en masse **dans un salon** |
 * | `/auth/password-reset` | établissement **+** adresse e-mail | le bombardement de la boîte mail **d'un compte** |
 * | `/platform/auth/login` | adresse e-mail seule | le forçage du mot de passe d'un opérateur |
 *
 * L'inscription ne se compte délibérément **pas** par adresse e-mail : un
 * attaquant qui crée des comptes en varie une à chaque essai, et un compteur par
 * adresse n'aurait borné que ce qui échouait déjà — deux inscriptions de la même
 * adresse dans le même salon, que l'unique `(tenant_id, email)` refuse. Le salon
 * est l'unité qui a un sens : c'est lui qu'on inonde, et c'est lui qui paie.
 *
 * ### Le 429 par cible n'est pas un oracle d'existence
 *
 * Le point mérite d'être écrit, parce que c'est l'objection qu'on oppose
 * naturellement à un compteur par compte sur une route qui, elle, refuse de dire
 * si le compte existe — `/auth/login` rend un `INVALID_CREDENTIALS` indistinct,
 * `/auth/password-reset` rend 202 quoi qu'il arrive.
 *
 * Le compteur **naît de la cible nommée, jamais du compte trouvé**. Rien de ce
 * que fait cette garde ne consulte la base : elle lit le corps brut, le
 * normalise, le hache, et incrémente. Une adresse inconnue produit donc
 * exactement le même compteur, au même rythme, avec le même 429 au même rang
 * qu'une adresse connue. Ce que le 429 apprend est « quelqu'un a déjà nommé
 * cette cible six fois cette minute » — c'est-à-dire ce que l'appelant vient
 * lui-même de faire.
 *
 * C'est aussi pourquoi le refus de la **base** reste invisible, lui, et doit le
 * rester : `PASSWORD_RESET_COOLDOWN_MS` ne s'applique qu'à un compte qui existe,
 * et un 429 tiré de celui-là aurait dit que l'adresse est connue. Il continue de
 * rendre 202 sans rien envoyer (`token.service.ts`, `auth.service.ts`).
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
 * ### Et ce que cela coûte en mémoire (#1128)
 *
 * Une clé par cible est une clé que l'appelant **fait naître** : un slug inventé
 * suffit, et il coûte moins qu'une connexion puisque la validation le refuse
 * **après** cette garde. Le stockage par défaut de `@nestjs/throttler` ne
 * supprimant jamais rien, cette croissance-là allait jusqu'au redémarrage de la
 * tâche. Elle est bornée depuis à une **fenêtre de trafic** par
 * `IdentityThrottlerStorage`, qui expulse ses entrées expirées et n'arme aucune
 * minuterie — voir son en-tête pour ce qu'il remplace, ce qu'il concède, et
 * pourquoi un plafond dur serait pire que le mal.
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
 * Marque une route **authentifiée** dont le quota se compte par compte (#1128).
 *
 * @see THROTTLE_BY_PRINCIPAL
 */
export const THROTTLE_BY_PRINCIPAL = 'identity/throttle-by-principal';

/** @see THROTTLE_BY_PRINCIPAL */
export const ThrottleByPrincipal = (): CustomDecorator<string> =>
  SetMetadata(THROTTLE_BY_PRINCIPAL, true);

/** Les deux usages de jeton signé qu'une route peut compter. */
export type ThrottleTokenKind = 'invitation' | 'password-reset';

/** Le jeton que le corps d'une route porte, et ce qu'il est. */
export interface ThrottleTokenFields {
  /**
   * L'usage du jeton — il décide de la clé de vérification, et deux usages ont
   * deux clés indépendantes (`token.service.ts`). Une invitation présentée à la
   * réinitialisation ne vérifie donc pas, et retombe sur l'adresse.
   */
  readonly kind: ThrottleTokenKind;
  /** Le champ du corps qui porte le jeton. */
  readonly field: string;
}

/** Métadonnée portée par `@ThrottleByToken()`. */
export const THROTTLE_BY_TOKEN = 'identity/throttle-by-token';

/**
 * Marque une route dont le quota se compte par **jeton signé présenté** (#1128).
 *
 * @see THROTTLE_BY_TOKEN
 */
export const ThrottleByToken = (fields: ThrottleTokenFields): CustomDecorator<string> =>
  SetMetadata(THROTTLE_BY_TOKEN, fields);

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
   * Les quatre marquages s'excluent : une route se compte par session, par
   * compte authentifié, par jeton **ou** par cible, jamais par deux à la fois.
   * L'ordre ci-dessous départage si quelqu'un en posait deux, et c'est sans
   * conséquence aujourd'hui — aucune route n'en porte deux, et l'en-tête dit
   * pourquoi `/auth/login` ne peut pas porter le premier.
   */
  private async trackerFor(request: Request, context: ExecutionContext): Promise<string | null> {
    if (this.metadataOf<boolean>(context, THROTTLE_BY_SESSION) === true) {
      return this.sessionTracker(request);
    }

    if (this.metadataOf<boolean>(context, THROTTLE_BY_PRINCIPAL) === true) {
      return this.principalTracker(request);
    }

    const token = this.metadataOf<ThrottleTokenFields>(context, THROTTLE_BY_TOKEN);
    if (token !== undefined) {
      return this.tokenTracker(request, token);
    }

    const fields = this.metadataOf<ThrottleTargetFields>(context, THROTTLE_BY_TARGET);
    return fields === undefined ? null : this.targetTracker(request, fields);
  }

  /**
   * La métadonnée que la route — ou son contrôleur — porte sous cette clé.
   *
   * Un seul point de lecture pour les quatre marquages : quatre copies de
   * `getAllAndOverride` auraient fini par différer d'un `getClass()` oublié, et
   * un marquage qui ne se lit qu'au niveau du gestionnaire cesse silencieusement
   * de valoir dès qu'on le pose sur le contrôleur.
   */
  private metadataOf<T>(context: ExecutionContext, key: string): T | undefined {
    return this.reflector.getAllAndOverride<T | undefined>(key, [
      context.getHandler(),
      context.getClass(),
    ]);
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
   * Le compte que cette requête **prouve**, ou `null` si elle n'en prouve aucun
   * (#1128).
   *
   * Le jeton est vérifié avant qu'on en tire le `sub`, pour la raison qui vaut
   * déjà pour la session : une revendication lue sans vérifier la signature est
   * une valeur que l'appelant choisit, et il lui suffirait d'en inventer une par
   * requête pour n'être jamais compté.
   *
   * `verifyAccessToken` rend `null` plutôt que de lever — c'est son contrat, une
   * route publique voyant passer des requêtes sans jeton en permanence.
   */
  private async principalTracker(request: Request): Promise<string | null> {
    const token = bearerToken(request);

    if (token === null) {
      return null;
    }

    const claims = await this.tokens.verifyAccessToken(token);
    return claims === null ? null : `principal:${claims.sub}`;
  }

  /**
   * Le compte que le jeton signé de ce corps désigne, ou `null` si le corps n'en
   * porte pas un qui vérifie (#1128).
   *
   * Le corps est lu **brut** — la garde précède le `ValidationPipe` —, donc
   * retypé avant tout. Un jeton qui ne vérifie pas ne désigne rien : ni un
   * compte, ni une entrée dans le stockage du limiteur.
   *
   * Le compteur est le `sub` et non le `jti` : c'est le **compte visé** qu'il
   * faut borner, et un compteur par émission repartirait de zéro à chaque
   * nouvelle demande de réinitialisation — c'est-à-dire à chaque fois que
   * quelqu'un en redemande une.
   */
  private async tokenTracker(
    request: Request,
    fields: ThrottleTokenFields,
  ): Promise<string | null> {
    const body: unknown = request.body;

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }

    const presented = (body as Record<string, unknown>)[fields.field];

    if (typeof presented !== 'string' || presented === '') {
      return null;
    }

    try {
      const claims =
        fields.kind === 'invitation'
          ? await this.tokens.verifyInvitationToken(presented)
          : await this.tokens.verifyPasswordResetToken(presented);

      return `${fields.kind}:${claims.sub}`;
    } catch {
      // Jeton contrefait, expiré, ou émis pour l'autre usage : les deux clés
      // sont indépendantes, et aucun des trois ne désigne de compte.
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
