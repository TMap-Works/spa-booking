import { MAX_REPORT_EXPORT_TTL_SECONDS } from '@spa/shared';

import {
  MIN_REPORT_EXPORT_TTL_SECONDS,
  ReportExportConfig,
  resolveReportExportSettings,
} from '../export/report-export.config';

/**
 * La configuration de l'entrepôt d'exports — #563.
 *
 * Deux décisions sont éprouvées ici, et ce sont celles qui ont des
 * conséquences : ce qui vaut « non configuré » (l'API doit démarrer quand
 * même), et le plafond de durée de vie (une URL présignée est un porteur).
 */

describe('resolveReportExportSettings', () => {
  it('rend `null` sans bucket — l’API démarre, seule la route d’export répond 503', () => {
    expect(resolveReportExportSettings({})).toBeNull();
  });

  it('traite la variable vide comme absente', () => {
    // C'est ce qu'ECS produit pour une variable déclarée sans valeur : « pas
    // posée », pas « mal posée ».
    expect(resolveReportExportSettings({ REPORT_EXPORT_BUCKET: '' })).toBeNull();
    expect(resolveReportExportSettings({ REPORT_EXPORT_BUCKET: '   ' })).toBeNull();
  });

  it('retient le bucket et la région, et plafonne la durée de vie par défaut', () => {
    expect(
      resolveReportExportSettings({
        REPORT_EXPORT_BUCKET: 'spa-dev-reporting-exports',
        AWS_REGION: 'eu-west-3',
      }),
    ).toEqual({
      bucket: 'spa-dev-reporting-exports',
      region: 'eu-west-3',
      ttlSeconds: MAX_REPORT_EXPORT_TTL_SECONDS,
    });
  });

  it('laisse la région à `null` quand rien ne la donne — le SDK la déduit', () => {
    expect(resolveReportExportSettings({ REPORT_EXPORT_BUCKET: 'b' })?.region).toBeNull();
  });

  it('accepte une durée de vie plus courte que le plafond', () => {
    expect(
      resolveReportExportSettings({ REPORT_EXPORT_BUCKET: 'b', REPORT_EXPORT_URL_TTL_SECONDS: '300' })
        ?.ttlSeconds,
    ).toBe(300);
  });

  it('refuse une durée de vie au-delà du plafond du contrat, plutôt que de la raboter', () => {
    // Rabotée en silence, l'erreur de l'opérateur ne se verrait jamais : il
    // croirait avoir posé une journée de confort là où il a posé une journée
    // de fuite.
    expect(() =>
      resolveReportExportSettings({
        REPORT_EXPORT_BUCKET: 'b',
        REPORT_EXPORT_URL_TTL_SECONDS: String(MAX_REPORT_EXPORT_TTL_SECONDS + 1),
      }),
    ).toThrow(/REPORT_EXPORT_URL_TTL_SECONDS/);
  });

  it('refuse une durée de vie sous le plancher — l’URL périmerait avant le clic', () => {
    expect(() =>
      resolveReportExportSettings({
        REPORT_EXPORT_BUCKET: 'b',
        REPORT_EXPORT_URL_TTL_SECONDS: String(MIN_REPORT_EXPORT_TTL_SECONDS - 1),
      }),
    ).toThrow(/REPORT_EXPORT_URL_TTL_SECONDS/);
  });

  it('refuse une durée de vie qui n’est pas un entier de secondes', () => {
    expect(() =>
      resolveReportExportSettings({
        REPORT_EXPORT_BUCKET: 'b',
        REPORT_EXPORT_URL_TTL_SECONDS: '15m',
      }),
    ).toThrow(/entier/);
  });
});

describe('ReportExportConfig', () => {
  it('se déclare non configuré sur un environnement nu', () => {
    const config = new ReportExportConfig({});

    expect(config.isConfigured).toBe(false);
    expect(config.resolved).toBeNull();
  });

  it('rend la configuration résolue dès qu’un bucket est posé', () => {
    const config = new ReportExportConfig({ REPORT_EXPORT_BUCKET: 'spa-prod-reporting-exports' });

    expect(config.isConfigured).toBe(true);
    expect(config.resolved?.bucket).toBe('spa-prod-reporting-exports');
  });
});
