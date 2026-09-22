import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { AppConfigService } from '../../config/app-config.service';
import { Auth } from './auth.decorator';
import { AuthService } from './auth.service';
import {
  AcceptInvitationDto,
  AuthenticatedAccountDto,
  AuthTokensDto,
  type LoginBody,
  LoginDto,
  type PasswordResetBody,
  type PasswordResetConfirmBody,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  type RegisterBody,
  RegisterDto,
  loginBody,
  passwordResetBody,
  passwordResetConfirmBody,
  registerBody,
} from './dto/auth.dto';
import type { RefreshResult } from './identity.types';
import { CurrentUser } from './jwt-auth.guard';
import type { AuthenticatedUser } from './identity.types';
import { permissionsOf } from './permissions';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie';
import {
  IdentityThrottlerGuard,
  ThrottleByPrincipal,
  ThrottleBySession,
  ThrottleByTarget,
  ThrottleByToken,
} from './identity-throttler.guard';
import { TenantBillingGate } from './tenant-billing.gate';
import { AllowUnpaidTenant } from './tenant-billing.guard';

/**
 * Points d'entrée d'authentification. Traduit HTTP ↔ service, et **rien
 * d'autre** : aucune règle métier ici (api-module §2).
 *
 * ## Limitation de débit
 *
 * `IdentityThrottlerGuard` couvre tout le contrôleur, et les quotas sont
 * resserrés là où ils comptent. Sans elle, un formulaire de connexion est un
 * oracle qu'on interroge à la vitesse du réseau : bcrypt coût 12 rend le forçage
 * *hors ligne* coûteux, il ne fait rien contre le forçage *en ligne*, où c'est
 * notre propre serveur qui paie le hachage.
 *
 * **Aucune de ces routes n'est appelée depuis un navigateur** : le front les
 * atteint par des actions serveur (`apps/web/lib/api-client.ts` lit `API_URL`,
 * non préfixée `NEXT_PUBLIC_`), si bien que leur `req.ip` est celui de la tâche
 * ECS du front — le même pour tous les établissements et tous les visiteurs. Un
 * quota compté par adresse y vaut donc pour le **produit entier**, et c'est le
 * défaut que #860 a d'abord corrigé sur `refresh`, #1127 sur les routes qui
 * jugent un mot de passe, puis #1128 sur celles qui restaient.
 *
 * Chaque route dit donc ce qu'elle compte, et le compteur suit ce qu'elle
 * protège (`identity-throttler.guard.ts`) :
 *
 * | Route | Compteur | Quota |
 * |---|---|---|
 * | `refresh` | la **session** prouvée par le cookie (`@ThrottleBySession()`) | 30 / min |
 * | `me` | le **compte** prouvé par le jeton d'accès (`@ThrottleByPrincipal()`) | 60 / min |
 * | `login` | la **cible** : établissement + adresse (`@ThrottleByTarget()`) | 10 / min |
 * | `register` | l'**établissement** visé (`@ThrottleByTarget()`) | 5 / min |
 * | `password-reset` | la **cible** : établissement + adresse (`@ThrottleByTarget()`) | 5 / min |
 * | `invitations/accept` | le **compte** que l'invitation désigne (`@ThrottleByToken()`) | 5 / min |
 * | `password-reset/confirm` | le **compte** que le lien désigne (`@ThrottleByToken()`) | 5 / min |
 *
 * Chacun de ces compteurs retombe sur l'adresse quand la requête ne prouve ni ne
 * nomme rien d'exploitable — un corps malformé, un jeton contrefait. C'est
 * voulu, et sans conséquence pour qui appelle normalement : ces requêtes-là sont
 * refusées juste après, et les ranger ensemble sur un compteur commun est ce
 * qu'il faut faire d'elles.
 *
 * ## La dernière route encore comptée par l'adresse : `logout`
 *
 * Elle ne porte pas de `@Throttle` et retombe sur le défaut du module, soixante
 * par minute pour la plateforme. C'est délibéré, et c'est le seul cas où le
 * plafond de plateforme reste le bon compromis.
 *
 * Le compteur par session serait pourtant à portée — le cookie est là. Mais
 * `logout` doit répondre 204 **même quand le cookie est illisible ou expiré**,
 * et c'est justement le cas où l'on s'en sert le plus : une session qui a duré.
 * Ces appels-là ne prouvent aucune session, retomberaient sur l'adresse, et le
 * marquage n'aurait donc déplacé que les déconnexions qui n'en avaient pas
 * besoin. Le nombre, lui, est large pour ce qu'il borne : une déconnexion par
 * fin de session, contre un rendu d'écran pour `me`.
 *
 * ## Ce qui reste ouvert, et qu'il ne faut pas lire comme réglé
 *
 * Aucun compteur applicatif ne borne le **flot** lui-même : un attaquant choisit
 * la cible qu'il nomme, donc le compteur qu'il consomme. Ce que ces compteurs
 * apportent est ce que les tickets demandaient — le forçage d'un compte donné
 * reste borné, et il ne l'est plus aux dépens des autres. Borner le flot
 * demande l'adresse réelle du visiteur, que le serveur Next devrait propager
 * jusqu'ici, et le limiteur d'entrée (`infra/terraform/`) en attendant.
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
@UseGuards(IdentityThrottlerGuard)
export class AuthController {
  public constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
    private readonly billing: TenantBillingGate,
  ) {}

  /**
   * Inscription client.
   *
   * Plus serré que la connexion : cinq comptes par minute **et par
   * établissement**, ce qui suffit largement à un usage réel et borne la
   * création de comptes en masse là où elle se paie — dans le salon qu'on
   * inonde.
   *
   * Le compteur est l'établissement seul, et non l'établissement plus l'adresse
   * : qui crée des comptes en masse varie l'adresse à chaque essai, et un
   * compteur par adresse n'aurait borné que la seule chose qui échouait déjà,
   * l'unique `(tenant_id, email)`. Voir `identity-throttler.guard.ts`, #1127.
   */
  @Post('register')
  @ThrottleByTarget({ tenant: 'tenantSlug' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Inscrire un client et ouvrir sa session' })
  // Déclaré explicitement : le corps est validé par le contrat partagé et le
  // paramètre est typé par un alias de type, dont `@nestjs/swagger` ne peut plus
  // rien déduire. `RegisterDto` ne sert plus qu'à cela (ADR 0008).
  @ApiBody({ type: RegisterDto })
  @ApiOkResponse({ type: AuthTokensDto })
  public async register(
    // Le type est celui **du contrat**, jamais `RegisterDto` : la classe n'a plus
    // de décorateur `class-validator`, et la typer ici ferait rejouer le
    // `ValidationPipe` global, dont le `whitelist` viderait le corps de tous ses
    // champs — l'inscription partirait alors sans e-mail ni mot de passe.
    @Body(registerBody) body: RegisterBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensDto> {
    const result = await this.auth.register({
      tenantSlug: body.tenantSlug,
      email: body.email,
      password: body.password,
      firstName: body.firstName,
      lastName: body.lastName,
      phone: body.phone,
      // Le booléen, pas une date : le service lit l'horloge du serveur (#880,
      // RGPD art. 7.1), et le `.strict()` du contrat refuse déjà tout
      // `dataConsentAt` glissé dans le corps.
      dataConsent: body.dataConsent,
      // La langue de la page d'où l'inscription part (#844). Facultative : elle
      // n'est pas saisie, elle est constatée — un appelant sans écran n'en a
      // aucune à donner, et le compte naît alors sans préférence.
      locale: body.locale,
    });

    return this.respondWithSession(response, result);
  }

  /**
   * Connexion — clients, staff et administrateurs.
   *
   * ## Dix tentatives par minute, **et par compte visé** (#1127)
   *
   * Au-delà de dix essais sur une même cible — le couple établissement +
   * adresse e-mail —, ce n'est plus quelqu'un qui se trompe de mot de passe.
   *
   * Le quota était compté par adresse IP jusqu'ici, et il ne bornait donc rien
   * de ce qu'il prétendait borner : aucun navigateur n'appelle cette route, tous
   * les salons y arrivent depuis la tâche ECS du front, et dix connexions par
   * minute valaient pour la plateforme entière. Onze gérants qui ouvrent leur
   * back-office à 9 h, et le onzième lisait « Trop de tentatives » ; la suite
   * E2E, qui enchaîne les connexions sur un worker unique, s'y heurtait de façon
   * déterministe.
   *
   * La cible est **normalisée puis hachée** avant de servir de clé : voir
   * `identity-throttler.guard.ts` pour ce que cela empêche — un compteur neuf à
   * chaque variation de casse, et une adresse e-mail lisible dans le stockage du
   * limiteur.
   *
   * Dix reste dix, et ce n'était pas le nombre qui était faux. La suite E2E
   * ouvre neuf sessions du même compte en cinquante secondes, ce qui passe mais
   * ne laisse qu'un essai de marge : c'est la suite qui se reconnecte comme
   * personne ne se reconnecte, et c'est elle qui est reprise (#1129) — pas ce
   * plafond, qui borne le forçage d'un mot de passe.
   */
  @Post('login')
  @ThrottleByTarget({ tenant: 'tenantSlug', account: 'email' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ouvrir une session' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: AuthTokensDto })
  public async login(
    @Body(loginBody) body: LoginBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensDto> {
    const result = await this.auth.login({
      tenantSlug: body.tenantSlug,
      email: body.email,
      password: body.password,
    });

    return this.respondWithSession(response, result);
  }

  /**
   * Première connexion d'un membre du personnel invité — #55.
   *
   * Publique, et elle ne peut pas être autrement : la personne invitée n'a pas
   * encore de mot de passe, donc pas de jeton d'accès. Ce qui l'autorise est
   * l'invitation elle-même — un jeton signé, à usage unique, qui ne vaut que pour
   * poser le **premier** mot de passe du compte qu'il désigne.
   *
   * Cinq tentatives par minute et **par compte invité** (#1128). Le corps ne
   * nomme aucune cible : il porte un jeton signé, et c'est de lui que le
   * compteur se tire — le `sub` d'une invitation qui vérifie. Ce que la limite
   * borne est le coût du bcrypt qu'un corps valide nous fait payer, et ce coût
   * se compte par compte visé plutôt qu'en travers de tous les salons : six
   * membres du personnel qui activent leur compte dans la même minute ne se
   * gênent plus.
   *
   * Un jeton contrefait ne vérifie pas, ne désigne aucun compte, et retombe sur
   * l'adresse — sans nous coûter de bcrypt, `verifyInvitationToken` précédant
   * `hash` dans le service.
   *
   * **200** et non 201 : rien n'est créé — le compte existait déjà, il est
   * activé. La réponse est celle d'une connexion, cookie de rafraîchissement
   * compris, pour que la personne n'ait pas à ressaisir le mot de passe qu'elle
   * vient de choisir.
   *
   * **401** sur tout refus, sans jamais dire lequel : jeton contrefait, expiré,
   * compte inconnu, désactivé, ou déjà activé.
   */
  @Post('invitations/accept')
  @ThrottleByToken({ kind: 'invitation', field: 'token' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activer un compte invité et ouvrir sa session' })
  @ApiOkResponse({ type: AuthTokensDto })
  public async acceptInvitation(
    @Body() body: AcceptInvitationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensDto> {
    const result = await this.auth.acceptInvitation({
      token: body.token,
      password: body.password,
    });

    return this.respondWithSession(response, result);
  }

  /**
   * Demande de réinitialisation d'un mot de passe oublié — #809, premier
   * critère.
   *
   * ## 202, toujours, et c'est le critère lui-même
   *
   * « Il répond **toujours 202**, que le compte existe ou non. » Un 404 sur une
   * adresse inconnue ferait de ce formulaire un annuaire de la clientèle du
   * salon, et l'énumération que `INVALID_CREDENTIALS` interdit à la connexion se
   * referait ici. Le service ne rend donc rien, et il n'y a pas de corps de
   * réponse à déclarer : 202 « la demande est acceptée », pas 200 « voilà le
   * résultat » — ce qui est exact, l'envoi ayant lieu après la réponse.
   *
   * Une seule chose peut encore échouer : le **slug**. Un établissement inconnu
   * ou désactivé rend 404, comme pour `login` et `register`, et c'est la moitié
   * « établissement désactivé » du sixième critère. Le slug est public — c'est
   * celui de l'URL de réservation — et son refus n'apprend rien que la page du
   * salon ne dise déjà ; répondre 202 sur un salon qui n'existe pas aurait
   * promis un courrier que personne n'enverrait.
   *
   * ## Cinq par minute et par cible, plus une limite par adresse en base
   *
   * Cinq demandes par minute suffisent largement à un usage réel — encore
   * fallait-il que ce soit cinq demandes **pour un compte** et non cinq pour la
   * plateforme entière, ce qu'un compteur d'adresse donnait ici : six personnes
   * qui cliquent « mot de passe oublié » dans la même minute, tous salons
   * confondus, et la sixième était refusée (#1128). La route nomme pourtant sa
   * cible, `tenantSlug` + `email`, et c'est elle que le décorateur compte
   * désormais.
   *
   * **Ce 429-là ne dit pas si l'adresse existe** : le compteur se tire de la
   * cible nommée, jamais du compte trouvé, et la garde ne consulte pas la base.
   * Une adresse inconnue produit le même compteur au même rythme qu'une adresse
   * connue. Voir `identity-throttler.guard.ts`, « Le 429 par cible n'est pas un
   * oracle d'existence ».
   *
   * Ce quota ne suffit toujours pas à lui seul : il est en mémoire de tâche,
   * donc divisé par le nombre de tâches. La moitié « par adresse » que le
   * critère exige reste en base (`users.password_reset_requested_at`,
   * `PASSWORD_RESET_COOLDOWN_MS`) : partagée par toutes les tâches, et durable à
   * travers leurs redémarrages.
   *
   * Ce refus-là, lui, est **invisible** — la route rend 202 et n'envoie rien —
   * et il doit le rester : il ne s'applique qu'à un compte qui existe, et un 429
   * tiré de celui-là aurait dit que l'adresse est connue.
   */
  @Post('password-reset')
  @ThrottleByTarget({ tenant: 'tenantSlug', account: 'email' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Demander la réinitialisation d’un mot de passe oublié' })
  @ApiBody({ type: PasswordResetRequestDto })
  @ApiAcceptedResponse({
    description:
      'La demande est acceptée. **Aucune réponse ne dit si l’adresse est connue** : ce code est ' +
      'le même pour un compte existant, une adresse inconnue, un compte désactivé et une ' +
      'demande trop rapprochée de la précédente.',
  })
  @ApiNotFoundResponse({ description: 'Aucun établissement actif ne porte ce slug.' })
  public async requestPasswordReset(
    // Le type est celui **du contrat**, jamais la classe : elle n'a plus de
    // décorateur `class-validator`, et la typer ici ferait rejouer le
    // `ValidationPipe` global, dont le `whitelist` viderait le corps.
    @Body(passwordResetBody) body: PasswordResetBody,
  ): Promise<void> {
    await this.auth.requestPasswordReset({
      tenantSlug: body.tenantSlug,
      email: body.email,
    });
  }

  /**
   * Choix du nouveau mot de passe, jeton en main — #809, troisième critère.
   *
   * Publique, et elle ne peut pas être autrement : la personne qui l'appelle
   * n'a, par hypothèse, plus accès à son compte. Ce qui l'autorise est le jeton
   * — un aléa de 256 bits signé, dont la base ne garde que l'empreinte, à usage
   * unique et valable trente minutes.
   *
   * ## 204 et non 200
   *
   * Rien n'est rendu, et surtout **aucune session n'est ouverte**. C'est la
   * différence avec `invitations/accept`, qui connecte la personne dans la
   * foulée, et elle est délibérée : une invitation prouve que son porteur est
   * bien l'invité — le compte n'avait pas de mot de passe, personne d'autre ne
   * pouvait l'attendre. Un lien de réinitialisation, lui, peut avoir été
   * ramassé dans une boîte mail restée ouverte sur un poste partagé. Faire
   * repasser par le formulaire de connexion coûte une saisie et prouve que le
   * porteur connaît le mot de passe qu'il vient de choisir. Le critère ne
   * demande rien d'autre, et il demande en revanche que **toutes** les sessions
   * du compte soient révoquées — y compris celle qu'on aurait ouverte ici.
   *
   * ## 401 sur tout refus, sans jamais dire lequel
   *
   * Jeton contrefait, expiré, déjà consommé, remplacé par une demande plus
   * récente, désignant un compte disparu ou désactivé, ou émis pour un autre
   * établissement : six causes, une réponse. Le point d'entrée n'est pas
   * authentifié, et la nuance dirait à qui présente un lien ramassé si le compte
   * qu'il désigne existe encore.
   *
   * Cinq tentatives par minute et **par compte visé**, comme l'acceptation
   * d'invitation et pour les mêmes raisons (#1128) : le jeton ne se devine pas,
   * cette limite borne surtout le coût du bcrypt qu'un corps valide nous ferait
   * payer, et ce coût n'a aucune raison de se partager entre tous les salons.
   *
   * Le compteur est le `sub` du jeton, jamais son `jti` : c'est le compte qu'il
   * faut borner, et un compteur par émission repartirait de zéro à chaque
   * nouvelle demande de réinitialisation.
   */
  @Post('password-reset/confirm')
  @ThrottleByToken({ kind: 'password-reset', field: 'token' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Poser un nouveau mot de passe depuis un lien de réinitialisation' })
  @ApiBody({ type: PasswordResetConfirmDto })
  @ApiNoContentResponse({
    description:
      'Le mot de passe est posé et **toutes les sessions du compte sont révoquées**. Aucune ' +
      'session n’est ouverte : la connexion se fait par le formulaire habituel.',
  })
  @ApiUnauthorizedResponse({
    description:
      'Lien invalide, expiré, déjà utilisé, remplacé par une demande plus récente, ou désignant ' +
      'un compte qui n’est plus en service. Les causes ne sont pas distinguées.',
  })
  public async confirmPasswordReset(
    @Body(passwordResetConfirmBody) body: PasswordResetConfirmBody,
  ): Promise<void> {
    await this.auth.confirmPasswordReset({
      token: body.token,
      password: body.password,
    });
  }

  /**
   * Rotation du jeton de rafraîchissement.
   *
   * Le jeton est lu dans le cookie et **jamais** dans le corps : un jeton qu'on
   * pourrait poster est un jeton que JavaScript peut lire, ce qui annulerait
   * `httpOnly`. Le corps de cette route est vide, et le `ValidationPipe` global
   * rejetterait tout champ qu'on y glisserait.
   *
   * **200 sans `Set-Cookie`** quand la requête a perdu une course contre un
   * autre renouvellement du même jeton (#856) : le jeton d'accès est rendu, le
   * cookie posé par le gagnant reste celui du client.
   *
   * ## Trente par minute, **et par session** (#860)
   *
   * C'est la seule route de ce contrôleur dont le quota ne se compte pas par
   * adresse IP, et la raison tient à qui l'appelle : personne, jamais, depuis un
   * navigateur. Le cookie est posé sur le domaine du front, et c'est le serveur
   * Next qui le relaie ici — tous les établissements arrivaient donc sur le même
   * compteur, et trente renouvellements par minute valaient pour le produit
   * entier. `@ThrottleBySession()` rattache le compteur au `sid` du jeton
   * vérifié ; le repli reste l'adresse pour une requête qui ne prouve aucune
   * session. Voir `identity-throttler.guard.ts`.
   *
   * Trente par minute et par session restent larges : une session renouvelle
   * toutes les quinze minutes, et la marge couvre les onglets multiples d'un
   * même poste sans rien laisser passer d'une boucle emballée.
   */
  @Post('refresh')
  @ThrottleBySession()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renouveler le jeton d’accès depuis le cookie de session' })
  @ApiOkResponse({ type: AuthTokensDto })
  public async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensDto> {
    // Le cookie absent n'a pas de branche à lui : il entre dans le service comme
    // une chaîne vide, y échoue à la vérification cryptographique, et produit
    // donc exactement la réponse d'un jeton invalide.
    const result = await this.auth.refresh(readRefreshCookie(request) ?? '');
    return this.respondWithSession(response, result);
  }

  /**
   * Déconnexion — révoque la session **en base** et efface le cookie.
   *
   * Répond toujours 204, y compris sans cookie ou avec un jeton illisible : le
   * résultat voulu est déjà atteint, et un échec n'apprendrait au client que ce
   * qu'il ne doit pas savoir.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Fermer la session et révoquer son jeton de rafraîchissement' })
  public async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(readRefreshCookie(request));
    clearRefreshCookie(response, { secure: this.config.isDeployed });
  }

  /**
   * Le compte porté par le jeton d'accès — **et ce qu'il a le droit de faire**
   * (#812, cinquième critère).
   *
   * `userId` vient de `@CurrentUser()`, donc d'un jeton vérifié — jamais d'un
   * paramètre d'URL. Une route `/users/:id` qui accepterait l'identifiant en
   * chemin serait la première fuite à écrire.
   *
   * ## Les permissions se dérivent du rôle **relu en base**, pas de celui du jeton
   *
   * Les deux coïncident presque toujours, et la nuance décide du cas qui compte :
   * un jeton d'accès vit quinze minutes, et un rôle rétrogradé pendant ce
   * quart d'heure y reste écrit. Dériver la liste de `profile.role` fait donc
   * disparaître l'entrée du sommaire au prochain rendu du shell plutôt qu'à la
   * prochaine connexion. L'inverse — un rôle promu — profite de la même
   * fraîcheur, sans qu'aucune route ne s'ouvre pour autant : c'est la garde qui
   * juge chaque appel, sur le jeton, et cette liste n'est qu'un affichage.
   *
   * ## Pourquoi la liste sort ici et nulle part ailleurs
   *
   * Voir l'en-tête d'`AuthenticatedAccountDto` : la porter dans la réponse d'une
   * connexion inviterait à la ranger avec le jeton, c'est-à-dire à la conserver
   * après qu'un administrateur l'a retirée.
   *
   * ## Soixante par minute, **et par compte** (#1128)
   *
   * Le back-office l'appelle à chaque rendu d'écran (`loadAdminShell`). Comptée
   * par adresse, elle plafonnait donc le produit entier à soixante rendus par
   * minute, toutes gérantes confondues : une poignée de salons ouverts en même
   * temps suffisait à fermer le back-office pour tout le monde. Le nombre
   * n'était pas faux, le compteur l'était.
   *
   * `@ThrottleByPrincipal()` le rattache au `sub` du jeton d'accès, vérifié dans
   * la garde — laquelle s'exécute **avant** `@Auth()`, l'ordre des gardes de Nest
   * mettant celles du contrôleur en premier. Une requête sans jeton valide
   * retombe donc sur l'adresse, et c'est bien ce qu'il faut d'elle : elle sera
   * refusée en 401 juste après.
   */
  @Get('me')
  @ThrottleByPrincipal()
  // `@Auth()` sans argument : toute identité vérifiée, quel que soit son rôle.
  // Lire son propre compte n'est pas un privilège, et la restreindre priverait
  // la clientèle de la seule route qui lui rend son profil. Surtout, aucune
  // permission ne peut être exigée ici : c'est la route qui les **annonce**, et
  // en demander une la rendrait inaccessible à qui n'en a aucune.
  @Auth()
  // Ouverte même quand l'abonnement est inactif : c'est par elle que le
  // back-office apprend qu'il est fermé (ADR 0016).
  @AllowUnpaidTenant()
  @ApiOperation({ summary: 'Lire le compte authentifié et ses permissions effectives' })
  @ApiOkResponse({ type: AuthenticatedAccountDto })
  public async me(@CurrentUser() user: AuthenticatedUser): Promise<AuthenticatedAccountDto> {
    const [profile, billing] = await Promise.all([
      this.auth.profileOf(user.userId),
      this.billing.billingOf(user.tenantId),
    ]);

    return {
      ...(billing === null
        ? {}
        : {
            billing: {
              status: billing.status,
              trialEndsAt: billing.trialEndsAt === null ? null : billing.trialEndsAt.toISOString(),
            },
          }),
      ...profile,
      // Copié plutôt que partagé : `permissionsOf` rend le tableau gelé de la
      // matrice, et le laisser filer dans un corps de réponse ferait dépendre
      // l'intégrité d'une table de processus de la discrétion de tout ce qui la
      // traverse ensuite.
      permissions: [...permissionsOf(profile.role)],
    };
  }

  /**
   * Pose le cookie de rafraîchissement et ne rend que ce qui peut l'être.
   *
   * Écrit en un seul endroit : c'est ce qui garantit que le jeton de
   * rafraîchissement ne part jamais dans un corps de réponse par distraction.
   *
   * Sans jeton de rafraîchissement — le perdant d'une course de renouvellement —,
   * aucun cookie ne part : ni neuf, qu'on n'a pas, ni vide, qui effacerait celui
   * que le gagnant vient de poser.
   */
  private respondWithSession(response: Response, result: RefreshResult): AuthTokensDto {
    if (result.refreshToken !== null) {
      setRefreshCookie(response, result.refreshToken, {
        secure: this.config.isDeployed,
        maxAgeSeconds: result.refreshTokenMaxAge,
      });
    }

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: { ...result.user },
    };
  }
}
