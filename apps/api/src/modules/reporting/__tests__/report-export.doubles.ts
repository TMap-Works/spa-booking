import type {
  ReportExportObject,
  ReportExportSignature,
  ReportExportStorage,
  ReportExportUpload,
} from '../export/report-export.storage';

/**
 * L'entrepôt d'exports en mémoire — partagé par la suite unitaire du service et
 * par les suites d'intégration et d'isolation d'`apps/api/test` (#563).
 *
 * Il reproduit les trois propriétés qui comptent, et rien de plus :
 *
 * 1. **une clé est une clé** — deux clés distinctes désignent deux objets
 *    distincts, et `find` répond sur la clé **exacte**. C'est ce qui fait que
 *    la suite d'isolation prouve quelque chose : le voisin recompose une clé
 *    sous son propre préfixe, ne la trouve pas, et reçoit 404 ;
 * 2. **la signature est bornée** — l'URL rendue porte la durée de vie demandée,
 *    ce qui permet de vérifier le plafond de quinze minutes sans parler à AWS ;
 * 3. **rien n'est deviné** — signer une clé absente est possible chez S3 comme
 *    ici (`getSignedUrl` calcule localement), et c'est précisément pourquoi le
 *    service vérifie l'existence *avant* de signer. Le double se garde bien de
 *    corriger ce défaut à sa place.
 *
 * Ce qu'il ne reproduit **pas** : le chiffrement au repos, le cycle de vie, la
 * politique de bucket. Ce sont des propriétés de l'infrastructure, et c'est
 * `terraform validate` qui en répond — les simuler ici prouverait la fidélité
 * d'une fixture à elle-même.
 */
export class FakeReportExportStorage implements ReportExportStorage {
  /** Les objets déposés, par clé — le contenu sert aux assertions de la suite. */
  public readonly objects = new Map<string, ReportExportUpload>();

  /** Les signatures demandées, dans l'ordre — pour éprouver la durée de vie. */
  public readonly signatures: ReportExportSignature[] = [];

  public put(upload: ReportExportUpload): Promise<void> {
    this.objects.set(upload.key, upload);

    return Promise.resolve();
  }

  public find(key: string): Promise<ReportExportObject | null> {
    const found = this.objects.get(key);

    // Le nom rendu est celui **du dépôt**, comme S3 le relit de sa métadonnée :
    // un double qui le recalculerait laisserait passer une re-signature qui
    // renomme le fichier.
    return Promise.resolve(found === undefined ? null : { filename: found.filename });
  }

  public presign(signature: ReportExportSignature): Promise<string> {
    this.signatures.push(signature);

    // La forme d'une URL présignée S3, réduite à ce dont les suites ont besoin :
    // un hôte, la clé, et l'échéance. Aucune signature n'est calculée — il n'y
    // a rien à vérifier d'une signature qu'on a soi-même fabriquée.
    return Promise.resolve(
      `https://exports.test.invalid/${signature.key}?X-Amz-Expires=${String(signature.ttlSeconds)}`,
    );
  }
}
