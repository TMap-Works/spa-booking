/**
 * Lambda d'envoi des notifications — le consommateur de `spa-{env}-notifications`.
 *
 * ## Ce que cette fonction est, et ce qu'elle n'est pas
 *
 * Elle est le **transport** : elle dépile la file, valide l'enveloppe, appelle
 * l'API et traduit sa réponse en une décision de rejeu. Elle n'est pas
 * l'expéditeur : la composition du message, la lecture de l'adresse et l'ordre
 * d'écriture `PENDING → fournisseur → SENT` appartiennent au module
 * `apps/api/src/modules/notifications`, que #68 a écrit et dont les suites
 * prouvent l'idempotence. Les réécrire ici en JavaScript donnerait deux
 * implémentations de la même règle, dans deux exécutables, avec un seul jeu de
 * tests — c'est-à-dire une divergence garantie.
 *
 * ## Les deux règles qui tiennent tout le fichier
 *
 * 1. **Aucune boucle de reprise maison.** Un enregistrement, un appel, une
 *    décision. Le rejeu est le métier de SQS, qui compte les tentatives jusqu'à
 *    la DLQ. Boucler ici doublerait la file, masquerait la profondeur de DLQ sur
 *    laquelle repose l'alarme, et retiendrait le lot entier pendant qu'un
 *    fournisseur est en panne. À savoir : SQS n'espace pas les tentatives — un
 *    message rendu revient au plus tard au bout du délai de visibilité, et cinq
 *    réceptions se consomment donc en un quart d'heure, pas en une nuit.
 *
 * 2. **Un échec permanent n'est jamais rejoué.** Adresse invalide, destinataire
 *    désinscrit, enveloppe illisible : rien de tout cela ne devient vrai en le
 *    répétant. Ces enregistrements sont acquittés — donc supprimés de la file —
 *    et comptés dans la métrique `PermanentFailures`, qui porte son alarme. Seul
 *    le transitoire — throttling, panne, coupure réseau — remonte dans
 *    `batchItemFailures`.
 *
 * ## Journalisation
 *
 * Des identifiants, jamais de coordonnée ni de contenu (CDC §5.1, skill
 * notifications §7). Le corps d'un message illisible n'est pas journalisé non
 * plus : on ne sait pas ce qu'il contient, c'est précisément pourquoi il est
 * rejeté.
 */

// --- Contrat de l'enveloppe ---------------------------------------------------

// Reflet de `NotificationMessage` (apps/api/src/modules/notifications/notifications.types.ts).
// Élargir ces ensembles revient à élargir le périmètre MVP : cela passe par une
// issue, pas par une ligne.
//
// `PASSWORD_RESET` est la quatrième valeur, ajoutée par #809 côté domaine et par
// #1032 dans ce miroir. Elle n'élargit pas le périmètre : le lien de
// réinitialisation relève de l'authentification, pas du marketing. L'écart entre
// les deux exemplaires est resté invisible aux suites parce qu'elles tournent
// toutes sans file branchée — la Lambda n'est employée que là où
// `NOTIFICATION_QUEUE_URL` est posée, c'est-à-dire en déployé seulement.
//
// **Exporté pour être confronté au domaine**, et pas seulement pour la forme :
// documenter l'obligation de les élargir d'un même lot ne l'a pas tenue une
// première fois. La fumigation lit `notifications.types.ts` et compare — c'est
// le même témoin que `__tests__/notifications.types.spec.ts` tient entre ce
// fichier-là et `schema.prisma`, à l'exemplaire près. Un export de plus ne coûte
// rien à l'artefact déployé : le runtime n'appelle que `handler`.
export const NOTIFICATION_TYPES = new Set([
  'BOOKING_CONFIRMATION',
  'REMINDER_24H',
  'CANCELLATION',
  'PASSWORD_RESET',
]);
const NOTIFICATION_CHANNELS = new Set(['EMAIL', 'SMS']);

/**
 * Les messages qui **annoncent un rendez-vous**, et qui doivent donc le nommer.
 *
 * C'est le seul endroit du contrat d'enveloppe où la forme dépend du type, et
 * cela n'en fait pas une règle métier de plus : un message de rendez-vous sans
 * rendez-vous n'a pas d'objet, et le refuser ici économise un appel à l'API pour
 * une enveloppe qu'aucun rendu ne pourrait servir — là où la laisser passer
 * rendrait un 404 dont le journal ne dirait pas ce qui manquait.
 *
 * `PASSWORD_RESET` en est absent : son enveloppe porte délibérément `null`
 * (`password-reset.listener.ts`), et c'est ce que `DispatchMessageDto` accepte
 * côté API depuis #809.
 */
const APPOINTMENT_NOTIFICATION_TYPES = new Set([
  'BOOKING_CONFIRMATION',
  'REMINDER_24H',
  'CANCELLATION',
]);

// --- Configuration ------------------------------------------------------------

const ENVIRONMENT = process.env.ENVIRONMENT ?? 'unknown';
const DISPATCH_URL = process.env.DISPATCH_URL ?? '';
const DISPATCH_TOKEN_SECRET_ARN = process.env.DISPATCH_TOKEN_SECRET_ARN ?? '';
// Repli si la variable est absente, vide ou illisible. Terraform la pose
// toujours et sa valeur est bornée par une validation ; mais un `NaN` ferait
// lever `AbortSignal.timeout` sur chaque message, et un zéro l'abandonnerait
// avant même de partir — deux pannes pour une variable mal recopiée à la main.
const DISPATCH_TIMEOUT_MS = positiveNumber(process.env.DISPATCH_TIMEOUT_MS, 5000);

function positiveNumber(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE ?? 'Spa/Notifications';

/**
 * Marge conservée avant la fin du temps imparti à l'invocation.
 *
 * Sans elle, la fonction serait tuée au milieu d'un appel : les
 * enregistrements non traités du lot ne figureraient dans aucun
 * `batchItemFailures`, et SQS les rendrait quand même — mais après le délai de
 * visibilité, sans que rien ne l'explique. Les rendre explicitement transitoires
 * quand le temps manque est la même reprise, en la disant.
 */
const TIME_GUARD_MS = 1_500;

// --- Classification des réponses ----------------------------------------------

/**
 * Codes qui ne changeront pas d'avis. Le contrat que l'API doit servir :
 *
 *   200/202  la notification est partie
 *   204/409  une autre livraison l'avait déjà prise — rejeu, rien à faire
 *   410      destinataire désinscrit ou supprimé
 *   422      adresse ou numéro invalide, modèle irrécupérable
 *   4xx      requête mal formée, route absente
 *
 * Un 401 ou un 403 est **transitoire**, et il faut s'y arrêter : un refus
 * d'authentification ne dit rien du message, il dit que la fonction ne s'est pas
 * fait reconnaître. Le jeton est lu une fois par démarrage à froid ; une
 * rotation du secret, un déploiement de l'API à mi-course ou une politique mal
 * posée refusent alors *tous* les messages. Les compter permanents les
 * acquitterait — donc les supprimerait de la file, sans qu'ils passent jamais
 * par la DLQ, et il n'y aurait plus rien à rejouer une fois le jeton corrigé.
 * Transitoires, ils épuisent leurs tentatives, atterrissent en DLQ, et s'y
 * rejouent le jour où la fonction se fait de nouveau reconnaître.
 */
const TRANSIENT_STATUSES = new Set([401, 403, 408, 425, 429]);
const SKIPPED_STATUSES = new Set([204, 409]);

/** Ce qu'un enregistrement peut devenir. `transient` est le seul qui se rejoue. */
const SENT = 'sent';
const SKIPPED = 'skipped';
const PERMANENT = 'permanent';
const TRANSIENT = 'transient';

// --- Jeton d'appel ------------------------------------------------------------

/**
 * Le jeton partagé, lu une fois par démarrage à froid.
 *
 * En cache pour ne pas payer un appel Secrets Manager par message ; jamais
 * journalisé, jamais rendu dans une erreur. Une lecture en échec est
 * **transitoire** : le secret existe, c'est l'appel qui a raté.
 */
let cachedToken = null;
let secretsManager = null;

/**
 * Import dynamique du SDK, et non `import` en tête de fichier.
 *
 * Le SDK v3 est fourni par le runtime `nodejs22.x`, pas par l'archive : un
 * import statique lierait le démarrage de la fonction à cette fourniture, y
 * compris quand aucun jeton n'est configuré et qu'elle n'a donc rien à lire.
 * Chargé ici, il ne coûte rien tant que `DISPATCH_TOKEN_SECRET_ARN` est vide —
 * ce qui est le cas par défaut — et le fichier reste importable partout.
 */
async function dispatchToken() {
  if (!DISPATCH_TOKEN_SECRET_ARN) return null;
  if (cachedToken !== null) return cachedToken;

  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );

  secretsManager ??= new SecretsManagerClient({});

  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: DISPATCH_TOKEN_SECRET_ARN }),
  );

  cachedToken = response.SecretString ?? '';
  return cachedToken;
}

// --- Validation de l'enveloppe ------------------------------------------------

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Le sort de `appointmentId`, rendu à part parce qu'il a trois issues et non deux.
 *
 * | Ce que porte l'enveloppe | `PASSWORD_RESET` | Les trois messages du CDC §1.4 |
 * |---|---|---|
 * | absent, ou `null` | accepté | `missing-appointment-id` |
 * | chaîne non vide | accepté | accepté |
 * | chaîne vide, nombre, objet… | `invalid-appointment-id` | `invalid-appointment-id` |
 *
 * L'absence et le nul sont traités ensemble, pour la raison qui vaut déjà pour
 * `scheduledFor` des deux côtés de la chaîne : un producteur qui omet le champ
 * n'envoie rien, là où une enveloppe sérialisée par `JSON.stringify` porte
 * `null`. Refuser l'une des deux formes perdrait la moitié des messages en échec
 * permanent — acquittés, donc irrécupérables.
 *
 * Une valeur **présente et mal formée** est un rejet distinct de l'absence, et
 * pour tous les types : ce n'est pas un producteur qui n'annonce aucun
 * rendez-vous, c'est un producteur qui en annonce un mal. Les deux ne se
 * diagnostiquent pas au même endroit, et le journal doit les distinguer.
 */
function appointmentIdRejection(message) {
  const { appointmentId } = message;

  if (appointmentId === undefined || appointmentId === null) {
    return APPOINTMENT_NOTIFICATION_TYPES.has(message.type) ? 'missing-appointment-id' : null;
  }

  return isNonEmptyString(appointmentId) ? null : 'invalid-appointment-id';
}

/**
 * Rend `null` quand l'enveloppe est conforme, sinon la raison du rejet.
 *
 * La raison est une chaîne fixe, pas un extrait du message : elle part dans les
 * journaux, et le contenu d'un message qu'on n'a pas su lire n'y a pas sa place.
 */
function envelopeRejection(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return 'payload-not-an-object';
  }
  // `tenantId` depuis #71 : c'est la seule chose de l'enveloppe qui ne se relise
  // pas côté API. Le consommateur ouvre sa portée de tenant dessus, et une
  // enveloppe qui en manquerait ferait ou bien échouer la lecture, ou bien —
  // beaucoup plus grave — la faire hors portée.
  if (!isNonEmptyString(message.tenantId)) return 'missing-tenant-id';
  if (!isNonEmptyString(message.dedupeKey)) return 'missing-dedupe-key';
  if (!isNonEmptyString(message.recipientUserId)) return 'missing-recipient-user-id';
  // Le type se valide **avant** le rendez-vous : c'est lui qui dit si l'enveloppe
  // doit en nommer un. Sur un type inconnu, la raison rendue est `unknown-type`
  // et non un verdict sur un champ dont on ne sait pas encore s'il est attendu.
  if (!NOTIFICATION_TYPES.has(message.type)) return 'unknown-type';
  if (!NOTIFICATION_CHANNELS.has(message.channel)) return 'unknown-channel';
  const appointmentRejection = appointmentIdRejection(message);
  if (appointmentRejection !== null) return appointmentRejection;
  if (message.scheduledFor !== null && message.scheduledFor !== undefined) {
    if (!isNonEmptyString(message.scheduledFor) || Number.isNaN(Date.parse(message.scheduledFor))) {
      return 'invalid-scheduled-for';
    }
  }
  return null;
}

// --- Journal et métriques -----------------------------------------------------

function log(level, event, fields) {
  process.stdout.write(`${JSON.stringify({ level, event, environment: ENVIRONMENT, ...fields })}\n`);
}

/**
 * Métriques au format EMF — CloudWatch les extrait du journal, sans que la
 * fonction ait besoin de `cloudwatch:PutMetricData` ni d'un appel synchrone de
 * plus dans le chemin d'envoi.
 *
 * Les quatre compteurs sont publiés à chaque invocation, y compris à zéro :
 * c'est ce qui distingue « rien à envoyer » de « plus personne ne consomme la
 * file », et ce qui rend l'alarme sur `PermanentFailures` lisible plutôt que
 * suspendue à une absence de donnée.
 */
function emitMetrics(counts) {
  process.stdout.write(
    `${JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [['Environment']],
            Metrics: [
              { Name: 'Sent', Unit: 'Count' },
              { Name: 'Skipped', Unit: 'Count' },
              { Name: 'PermanentFailures', Unit: 'Count' },
              { Name: 'TransientFailures', Unit: 'Count' },
            ],
          },
        ],
      },
      Environment: ENVIRONMENT,
      Sent: counts.sent,
      Skipped: counts.skipped,
      PermanentFailures: counts.permanent,
      TransientFailures: counts.transient,
    })}\n`,
  );
}

// --- Traitement d'un enregistrement -------------------------------------------

/**
 * Un enregistrement, un appel, une décision — la règle n°1 en une fonction.
 */
async function handleRecord(record) {
  let message;
  try {
    message = JSON.parse(record.body);
  } catch {
    log('error', 'notification.rejected', { messageId: record.messageId, reason: 'invalid-json' });
    return PERMANENT;
  }

  const rejection = envelopeRejection(message);
  if (rejection !== null) {
    log('error', 'notification.rejected', { messageId: record.messageId, reason: rejection });
    return PERMANENT;
  }

  // Les identifiants seuls — l'enveloppe ne porte de toute façon aucune
  // coordonnée, c'est la règle du contrat côté API.
  const context = {
    messageId: record.messageId,
    tenantId: message.tenantId,
    dedupeKey: message.dedupeKey,
    // `?? null` plutôt que la valeur brute : `undefined` disparaîtrait de la
    // ligne JSON, et le champ manquerait au journal exactement sur les messages
    // qui n'annoncent aucun rendez-vous — là où sa présence à `null` est
    // l'information (#1032).
    appointmentId: message.appointmentId ?? null,
    type: message.type,
    channel: message.channel,
  };

  if (!DISPATCH_URL) {
    // Défaut fermé : sans destination, rien ne part et rien n'est acquitté. Le
    // message épuise ses réceptions, part en DLQ, et l'alarme de profondeur
    // parle — ce qui est exactement ce qu'on veut voir quand la chaîne n'est pas
    // branchée.
    log('error', 'notification.unconfigured', { ...context, reason: 'dispatch-url-unset' });
    return TRANSIENT;
  }

  let token;
  try {
    token = await dispatchToken();
  } catch (error) {
    // `code` en plus de `name` : une lecture de secret rate pour deux familles de
    // raisons qui ne se réparent pas au même endroit — un refus IAM ou une panne
    // réseau d'un côté, un `ERR_MODULE_NOT_FOUND` de l'autre, qui dirait que le
    // runtime ne fournit pas `@aws-sdk/client-secrets-manager`. Sans le code,
    // les deux se ressemblent : `Error`.
    log('error', 'notification.token_unavailable', {
      ...context,
      reason: error.name,
      code: error.code,
    });
    return TRANSIENT;
  }

  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-internal-token'] = token;

  let response;
  try {
    response = await fetch(DISPATCH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messageId: record.messageId, message }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
  } catch (error) {
    // Coupure, DNS, délai dépassé : rien de tout cela ne dit que le message est
    // mauvais. Transitoire, donc rendu à SQS.
    log('warn', 'notification.transport_failed', { ...context, reason: error.name });
    return TRANSIENT;
  }

  const status = response.status;

  // Le corps ne nous apprend rien — c'est le code qui décide — mais il faut le
  // vider. `fetch` ne rend la connexion au pool qu'une fois le flux consommé ou
  // annulé : la laisser pendante en retient une par message, et un conteneur
  // chaud qui dépile des milliers de messages accumule autant de sockets
  // ouvertes jusqu'à la panne. `catch` vide : une annulation qui échoue ne doit
  // pas requalifier un envoi réussi en échec.
  await response.body?.cancel().catch(() => {});

  if (SKIPPED_STATUSES.has(status)) {
    log('info', 'notification.skipped', { ...context, status });
    return SKIPPED;
  }

  if (status >= 200 && status < 300) {
    log('info', 'notification.sent', { ...context, status });
    return SENT;
  }

  if (status >= 500 || TRANSIENT_STATUSES.has(status)) {
    log('warn', 'notification.retryable', { ...context, status });
    return TRANSIENT;
  }

  log('error', 'notification.permanent_failure', { ...context, status });
  return PERMANENT;
}

// --- Point d'entrée -----------------------------------------------------------

export async function handler(event, context) {
  const counts = { sent: 0, skipped: 0, permanent: 0, transient: 0 };
  const batchItemFailures = [];
  const records = event?.Records ?? [];

  // Séquentiel, délibérément. Le parallélisme se règle en amont, par la
  // concurrence maximale de la source d'événements : traiter dix appels de front
  // ici multiplierait la charge sur l'API sans qu'aucun réglage d'infrastructure
  // ne le borne.
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    const remaining =
      typeof context?.getRemainingTimeInMillis === 'function'
        ? context.getRemainingTimeInMillis()
        : Number.POSITIVE_INFINITY;

    if (remaining < DISPATCH_TIMEOUT_MS + TIME_GUARD_MS) {
      // Le reste du lot est rendu à SQS plutôt que tué en vol.
      for (let rest = index; rest < records.length; rest += 1) {
        batchItemFailures.push({ itemIdentifier: records[rest].messageId });
        counts.transient += 1;
      }
      log('warn', 'notification.batch_deadline', {
        processed: index,
        returned: records.length - index,
      });
      break;
    }

    const outcome = await handleRecord(record);

    if (outcome === TRANSIENT) {
      counts.transient += 1;
      batchItemFailures.push({ itemIdentifier: record.messageId });
    } else if (outcome === PERMANENT) {
      counts.permanent += 1;
    } else if (outcome === SKIPPED) {
      counts.skipped += 1;
    } else {
      counts.sent += 1;
    }
  }

  emitMetrics(counts);

  // Réponse partielle : SQS ne rend que les enregistrements nommés ici et
  // supprime les autres. Lever à la place ferait rejouer le lot entier, donc
  // rappellerait l'API pour des messages déjà envoyés.
  return { batchItemFailures };
}
