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
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { AppConfigService } from '../../config/app-config.service';
import { Auth } from './auth.decorator';
import { AuthService } from './auth.service';
import {
  AcceptInvitationDto,
  AuthTokensDto,
  type LoginBody,
  LoginDto,
  type RegisterBody,
  RegisterDto,
  UserProfileDto,
  loginBody,
  registerBody,
} from './dto/auth.dto';
import type { RefreshResult } from './identity.types';
import { CurrentUser } from './jwt-auth.guard';
import type { AuthenticatedUser } from './identity.types';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie';
import { SessionThrottlerGuard, ThrottleBySession } from './session-throttler.guard';

/**
 * Points d'entrée d'authentification. Traduit HTTP ↔ service, et **rien
 * d'autre** : aucune règle métier ici (api-module §2).
 *
 * ## Limitation de débit
 *
 * `SessionThrottlerGuard` couvre tout le contrôleur, et les quotas sont resserrés
 * là où ils comptent. Sans elle, un formulaire de connexion est un oracle qu'on
 * interroge à la vitesse du réseau : bcrypt coût 12 rend le forçage *hors ligne*
 * coûteux, il ne fait rien contre le forçage *en ligne*, où c'est notre propre
 * serveur qui paie le hachage.
 *
 * Le compteur est par adresse IP — ce que `@nestjs/throttler` sait faire sans
 * état partagé. Ce n'est pas une protection complète : un attaquant distribué la
 * contourne. Elle arrête ce qu'elle doit arrêter à ce stade — le forçage depuis
 * une seule origine — et le durcissement par compte, avec compteur en Redis,
 * demandera le stockage partagé que le MVP n'a pas encore câblé.
 *
 * **Une route fait exception, et elle le dit** : `refresh`, où l'adresse IP ne
 * désigne plus personne parce qu'aucun navigateur ne l'appelle. Elle porte
 * `@ThrottleBySession()`, et son compteur suit la session
 * (`session-throttler.guard.ts`, #860).
 *
 * **Le même angle mort vaut pour les autres routes, et il reste ouvert.**
 * `login`, `register`, `invitations/accept` et `logout` ne sont pas davantage
 * appelées depuis un navigateur : le front les atteint par des actions serveur
 * (`apps/web/lib/api-client.ts` lit `API_URL`, non préfixée `NEXT_PUBLIC_`), si
 * bien que leur `req.ip` est lui aussi celui de la tâche ECS du front. Leurs
 * quotas — dix connexions, cinq inscriptions par minute — valent donc pour le
 * **produit entier** et non par visiteur. `@ThrottleBySession()` ne peut pas les
 * couvrir, et pas par oubli : un compteur par session y rendrait le forçage
 * amplifiable (voir `session-throttler.guard.ts`). Les fermer demande soit le
 * compteur par compte en Redis évoqué ci-dessus, soit la propagation de
 * l'adresse réelle du visiteur par le serveur Next — deux chantiers que le MVP
 * n'a pas câblés.
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
@UseGuards(SessionThrottlerGuard)
export class AuthController {
  public constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Inscription client.
   *
   * Plus serré que la connexion : cinq comptes par minute et par IP suffisent
   * largement à un usage réel, et bornent la création de comptes en masse.
   */
  @Post('register')
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
    });

    return this.respondWithSession(response, result);
  }

  /**
   * Connexion — clients, staff et administrateurs.
   *
   * Dix tentatives par minute et par IP : au-delà, ce n'est plus quelqu'un qui se
   * trompe de mot de passe.
   */
  @Post('login')
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
   * Cinq tentatives par minute et par IP, comme l'inscription : le jeton porte
   * 256 bits de signature, il ne se devine pas, et cette limite borne surtout le
   * coût du bcrypt qu'un corps valide nous ferait payer.
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
   * session. Voir `session-throttler.guard.ts`.
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
   * Le compte porté par le jeton d'accès.
   *
   * `userId` vient de `@CurrentUser()`, donc d'un jeton vérifié — jamais d'un
   * paramètre d'URL. Une route `/users/:id` qui accepterait l'identifiant en
   * chemin serait la première fuite à écrire.
   */
  @Get('me')
  // `@Auth()` sans argument : toute identité vérifiée, quel que soit son rôle.
  // Lire son propre compte n'est pas un privilège, et la restreindre priverait
  // la clientèle de la seule route qui lui rend son profil.
  @Auth()
  @ApiOperation({ summary: 'Lire le compte authentifié' })
  @ApiOkResponse({ type: UserProfileDto })
  public async me(@CurrentUser() user: AuthenticatedUser): Promise<UserProfileDto> {
    return this.auth.profileOf(user.userId);
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
