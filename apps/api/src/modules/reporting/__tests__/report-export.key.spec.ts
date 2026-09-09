import {
  REPORT_EXPORT_KEY_PREFIX,
  reportExportFilename,
  reportExportKey,
} from '../export/report-export.key';
import type { ReportWindow } from '../reporting.types';

/**
 * La clé d'objet et le nom de fichier d'un export — #563, deuxième critère.
 *
 * Deux propriétés seulement, et ce sont les deux qui portent la sécurité du
 * ticket : la clé **commence** par l'établissement, et le nom du fichier dit la
 * période réellement couverte.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const EXPORT_ID = '33333333-3333-4333-8333-333333333333';


/**
 * Septembre 2026 **tel qu'un salon parisien le vit** — du 1er 00 h 00 locale au
 * 1er octobre 00 h 00 locale, borne haute exclue.
 *
 * Les instants sont décalés de deux heures parce que Paris est à UTC+2 en
 * septembre. Ce n'est pas une coquetterie de fixture : c'est exactement ce que
 * l'écran envoie (`apps/web/lib/admin/reporting-window.ts`, `windowOfRange`),
 * une fenêtre calée sur le fuseau du salon et non sur UTC.
 */
const SEPTEMBRE_PARIS: ReportWindow = {
  from: new Date('2026-08-31T22:00:00Z'),
  to: new Date('2026-09-30T22:00:00Z'),
};

/** Le même mois de septembre, vu d'un salon à Papeete (UTC−10). */
const SEPTEMBRE_TAHITI: ReportWindow = {
  from: new Date('2026-09-01T10:00:00Z'),
  to: new Date('2026-10-01T10:00:00Z'),
};

describe('reportExportKey', () => {
  it('préfixe la clé par le tenant, sous le préfixe d’exports', () => {
    expect(reportExportKey(TENANT_A, EXPORT_ID)).toBe(
      `${REPORT_EXPORT_KEY_PREFIX}/${TENANT_A}/${EXPORT_ID}.csv`,
    );
  });

  it('donne deux clés disjointes au même export vu par deux établissements', () => {
    // C'est *toute* la propriété d'isolation, réduite à une ligne : le même
    // identifiant présenté par le voisin ne désigne pas le même objet, donc
    // n'en désigne aucun chez lui.
    expect(reportExportKey(TENANT_A, EXPORT_ID)).not.toBe(reportExportKey(TENANT_B, EXPORT_ID));
  });

  it('place le tenant en tête, et pas ailleurs dans la clé', () => {
    const key = reportExportKey(TENANT_A, EXPORT_ID);

    // Un préfixe qui viendrait après un segment variable ne bornerait rien :
    // c'est sur `exports/{tenant}/` que la politique IAM et le raisonnement de
    // ce ticket s'appuient.
    expect(key.startsWith(`${REPORT_EXPORT_KEY_PREFIX}/${TENANT_A}/`)).toBe(true);
  });
});

describe('reportExportFilename', () => {
  it('préfixe le fichier par le slug et borne la période aux dates réellement couvertes', () => {
    // La fenêtre a sa borne haute **exclue** : le fichier couvre jusqu'au 30
    // septembre, et écrire `2026-10-01` aurait annoncé un jour absent du
    // fichier. C'est la seule raison pour laquelle la borne haute est reculée
    // d'une milliseconde avant d'être découpée.
    expect(reportExportFilename('maison-lotus', SEPTEMBRE_PARIS, 'Europe/Paris')).toBe(
      'maison-lotus-reporting-2026-09-01_2026-09-30.csv',
    );
  });

  it('donne le même mois à un salon de Papeete, sur d’autres instants', () => {
    // Septembre à Papeete n'est pas septembre à Paris : ce sont deux fenêtres
    // d'instants distinctes, et le nom du fichier doit malgré tout dire
    // « septembre » des deux côtés.
    expect(reportExportFilename('lagon-bleu', SEPTEMBRE_TAHITI, 'Pacific/Tahiti')).toBe(
      'lagon-bleu-reporting-2026-09-01_2026-09-30.csv',
    );
  });

  it('découpe les dates dans le fuseau demandé, jamais en UTC', () => {
    // La même fenêtre lue dans deux fuseaux ne donne pas le même nom : c'est la
    // preuve que le fuseau sert, et qu'un nom de fichier ne se calcule pas sur
    // l'horloge du serveur — laquelle n'est le fuseau de personne.
    expect(reportExportFilename('lagon-bleu', SEPTEMBRE_TAHITI, 'Europe/Paris')).toBe(
      'lagon-bleu-reporting-2026-09-01_2026-10-01.csv',
    );
  });

  it('tient sur une fenêtre d’une seule journée', () => {
    const journee: ReportWindow = {
      from: new Date('2026-09-02T22:00:00Z'),
      to: new Date('2026-09-03T22:00:00Z'),
    };

    expect(reportExportFilename('salon-a', journee, 'Europe/Paris')).toBe(
      'salon-a-reporting-2026-09-03_2026-09-03.csv',
    );
  });
});
